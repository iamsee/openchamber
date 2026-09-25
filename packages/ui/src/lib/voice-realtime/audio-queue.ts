/**
 * Gapless TTS playback queue for realtime voice.
 *
 * Sentences arrive as raw PCM16 at the TTS rate (24 kHz for Kokoro) and are
 * written straight into AudioBuffers with `createBuffer` + `copyToChannel`.
 * `decodeAudioData` is never used for that format: there is no container left to
 * parse (the server strips the WAV header), and a main-thread decode would
 * compete with capture for the same core the VAD depends on (plan §5.2). MP3 is
 * the only format that needs a decoder, and the only one that carries codec
 * padding, so near-silence trimming lives on that path alone.
 *
 * Scheduling is one cursor: every source starts exactly when the previous one
 * ends, so sentence boundaries are sample-continuous and no cross-fade is needed
 * — cross-fading cannot fix codec padding anyway and is rejected (plan §0 row 3).
 *
 * Interrupts ramp the master gain down before anything stops. Cutting a source
 * mid-waveform sends a DC step to the speaker, and an interrupt is the
 * most-listened moment in the feature (plan §4 rule 2).
 */

import { TTS_FORMAT_PCM16, type InboundAudioFrame } from './protocol';

/**
 * Cold-start lead. Scheduling at exactly `currentTime` races the render quantum
 * already in flight, which shows up as a clipped first syllable; 20 ms is
 * inaudible against a multi-second pipeline and only applies when the queue is
 * empty, never between chunks.
 */
const FIRST_CHUNK_LEAD_SECONDS = 0.02;
/** `setTargetAtTime` constant for an interrupt: ~5 ms to silence. */
const FLUSH_GAIN_TIME_CONSTANT_SECONDS = 0.005;
/** Sources stop four time constants later, below 2% amplitude. */
const FLUSH_STOP_DELAY_SECONDS = 0.02;
const DUCK_TIME_CONSTANT_SECONDS = 0.01;
/** ~-46 dBFS. Below this a sample is codec padding, not a soft consonant. */
const SILENCE_TRIM_THRESHOLD = 0.005;
const SILENCE_TRIM_MAX_SECONDS = 0.05;

/**
 * Where the next chunk starts: at the cursor when the queue is warm, otherwise
 * `leadSeconds` from now. Never in the past — a source started in the past plays
 * from its beginning immediately and the gap becomes an audible hole.
 */
export const computeChunkStartTime = (now: number, scheduledEnd: number, leadSeconds: number): number =>
  Math.max(now + leadSeconds, scheduledEnd);

/** PCM16LE -> float32 in Web Audio's [-1, 1) range. */
export const pcm16ToFloat32 = (payload: ArrayBuffer): Float32Array<ArrayBuffer> => {
  const sampleCount = Math.floor(payload.byteLength / 2);
  const samples = new Float32Array(sampleCount);
  const view = new DataView(payload);
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 32768;
  }
  return samples;
};

/**
 * The [start, end) window left after dropping near-silent edges. Trimming is
 * capped at half the buffer, and a buffer that is silent all the way through
 * keeps every sample — an empty window would become an empty AudioBuffer, which
 * `createBuffer` rejects.
 */
export const findNearSilenceWindow = (
  samples: Float32Array,
  maxTrimSamples: number,
  threshold = SILENCE_TRIM_THRESHOLD,
): { start: number; end: number } => {
  const limit = Math.max(0, Math.min(maxTrimSamples, Math.floor(samples.length / 2)));

  let start = 0;
  while (start < limit && Math.abs(samples[start]) < threshold) {
    start += 1;
  }
  let end = samples.length;
  while (end > samples.length - limit && end > start && Math.abs(samples[end - 1]) < threshold) {
    end -= 1;
  }
  if (end <= start) {
    return { start: 0, end: samples.length };
  }
  return { start, end };
};

export interface AudioQueue {
  enqueue(frame: InboundAudioFrame): Promise<void>;
  /** Ramp the master gain to 0 over ~5 ms, THEN stop and disconnect sources. */
  flush(turnId: number): void;
  /**
   * Fires when the queue runs out of scheduled audio for the turn that is still
   * active. Guarded against the `onended` storm an interrupt causes: a source
   * that was cut carries a superseded turnId and never reports a drain.
   *
   * A turn can drain more than once if synthesis is slower than playback, so
   * treat this as "nothing is queued right now" and combine it with the server's
   * `audio_end` before declaring a turn finished.
   */
  onDrained(cb: (turnId: number) => void): void;
  /** Master gain 0..1, for echo mitigation. Smoothed, so it cannot click. */
  setDucking(v: number): void;
  /** Context-time seconds at which the last scheduled source ends; 0 when idle. */
  scheduledEndTime(): number;
  dispose(): void;
}

interface QueueEntry {
  source: AudioBufferSourceNode;
  turnId: number;
  /** Context time the source was scheduled for, so a cut can tell it apart. */
  startedAt: number;
  stopping: boolean;
}

const safeDisconnect = (node: AudioNode | null): void => {
  if (!node) {
    return;
  }
  try {
    node.disconnect();
  } catch {
    // Already disconnected — teardown runs on nodes in every state.
  }
};

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const createAudioQueue = (context: AudioContext): AudioQueue => {
  const master = context.createGain();
  master.connect(context.destination);

  const drainedListeners = new Set<(turnId: number) => void>();
  const entries = new Set<QueueEntry>();

  /** Sources that can still report a natural drain (i.e. not being cut). */
  let liveEntries = 0;
  let scheduledEnd = 0;
  let activeTurnId: number | null = null;
  /** Highest turnId an interrupt has already killed; frames at or below it die. */
  let flushedThroughTurnId = 0;
  let ducking = 1;
  /** Master gain is ramped to zero by an interrupt and not yet restored. */
  let muted = false;
  let disposed = false;

  const buildPcm16Buffer = (payload: ArrayBuffer, sampleRate: number): AudioBuffer | null => {
    const samples = pcm16ToFloat32(payload);
    if (samples.length === 0) {
      return null;
    }
    // The buffer's rate is the TTS rate, NOT context.sampleRate. A 24 kHz buffer
    // in a 48 kHz context is correct: Web Audio resamples on playback and
    // `buffer.duration` stays valid, which is what the cursor schedules against
    // (plan §4 rule 4). iOS locks the context to the hardware rate — 48 kHz, or
    // 24/44.1 kHz over Bluetooth — so treating them as equal would play every
    // sentence at the wrong speed on the platform that matters most.
    const buffer = context.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);
    return buffer;
  };

  const trimDecodedEdges = (decoded: AudioBuffer): AudioBuffer => {
    const maxTrim = Math.floor(SILENCE_TRIM_MAX_SECONDS * decoded.sampleRate);
    const { start, end } = findNearSilenceWindow(decoded.getChannelData(0), maxTrim);
    const length = end - start;
    if (length === decoded.length) {
      return decoded;
    }
    const trimmed = context.createBuffer(decoded.numberOfChannels, length, decoded.sampleRate);
    for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
      trimmed.copyToChannel(decoded.getChannelData(channel).subarray(start, end), channel);
    }
    return trimmed;
  };

  const buildAudioBuffer = async (frame: InboundAudioFrame): Promise<AudioBuffer | null> => {
    if (frame.format === TTS_FORMAT_PCM16) {
      return buildPcm16Buffer(frame.payload, frame.sampleRate);
    }
    // decodeAudioData detaches its argument, so it gets a copy of a payload the
    // caller may still hold.
    const decoded = await context.decodeAudioData(frame.payload.slice(0));
    return trimDecodedEdges(decoded);
  };

  const restoreGainAt = (when: number): void => {
    // Restoring at the new source's start time, never at `now`: the sources the
    // interrupt cut are still ramping down until then, and un-muting early would
    // let their tail back through. Nothing is playing at `when`, so the step
    // from ~0 to `ducking` is silent.
    master.gain.cancelScheduledValues(when);
    master.gain.setValueAtTime(ducking, when);
    muted = false;
  };

  const handleEnded = (entry: QueueEntry): void => {
    entries.delete(entry);
    entry.source.onended = null;
    safeDisconnect(entry.source);
    if (!entry.stopping) {
      liveEntries -= 1;
    }

    if (disposed) {
      if (entries.size === 0) {
        safeDisconnect(master);
      }
      return;
    }

    // plan §4 rule 3: N scheduled sources × stop() = N async `onended`. A cut
    // source carries a superseded turnId, so it can neither report a drain nor
    // move the caller's state machine back to idle after an interrupt.
    if (entry.stopping || entry.turnId !== activeTurnId || liveEntries > 0) {
      return;
    }

    scheduledEnd = 0;
    for (const listener of drainedListeners) {
      listener(entry.turnId);
    }
  };

  const schedule = (turnId: number, buffer: AudioBuffer): void => {
    const start = computeChunkStartTime(context.currentTime, scheduledEnd, FIRST_CHUNK_LEAD_SECONDS);
    if (muted) {
      restoreGainAt(start);
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(master);

    const entry: QueueEntry = { source, turnId, startedAt: start, stopping: false };
    entries.add(entry);
    liveEntries += 1;
    source.onended = () => handleEnded(entry);
    source.start(start);
    scheduledEnd = start + buffer.duration;
  };

  const cutScheduledSources = (): void => {
    const now = context.currentTime;
    const stopAt = now + FLUSH_STOP_DELAY_SECONDS;

    // Ramp first, stop second: `setTargetAtTime` glides the master to silence and
    // the sources are cut four time constants later, below audible amplitude.
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.setTargetAtTime(0, now, FLUSH_GAIN_TIME_CONSTANT_SECONDS);
    muted = true;
    scheduledEnd = 0;

    for (const entry of entries) {
      if (entry.stopping) {
        continue;
      }
      entry.stopping = true;
      liveEntries -= 1;
      if (entry.startedAt > now) {
        // Queued behind the cursor and never audible: there is no waveform to
        // truncate, so release it directly instead of waiting for an `onended`
        // that a source stopped before its start time may never fire.
        entry.source.onended = null;
        entry.source.stop();
        entries.delete(entry);
        safeDisconnect(entry.source);
        continue;
      }
      entry.source.stop(stopAt);
    }
  };

  /**
   * Whether a frame for `turnId` may still be played. Frames for a turn an
   * interrupt already killed are dropped even when they were in flight — that is
   * the tail of a barge-in arriving after `flush_audio` (plan §4 rule 1).
   */
  const acceptsTurn = (turnId: number): boolean => {
    if (turnId <= flushedThroughTurnId) {
      return false;
    }
    return activeTurnId === null || turnId >= activeTurnId;
  };

  const enqueue = async (frame: InboundAudioFrame): Promise<void> => {
    if (disposed || !acceptsTurn(frame.turnId)) {
      return;
    }

    let buffer: AudioBuffer | null;
    try {
      buffer = await buildAudioBuffer(frame);
    } catch (error) {
      // A chunk that cannot be decoded is lost audio, not a dead session: keep
      // playing what is scheduled and say so once per bad chunk. Never reject —
      // callers enqueue ten frames a second from a socket handler.
      console.warn(
        `[voice-realtime] dropping undecodable tts chunk (turn ${frame.turnId}, sentence ${frame.sentenceIndex}): ${describeError(error)}`,
      );
      return;
    }

    // Re-check after the await: an interrupt can land while a frame is still
    // being converted, and playing its tail is exactly the bug the turnId gate
    // exists to prevent (plan §4 rule 1). Format 0 converts synchronously, so
    // this only bites the MP3 fallback — where it bites hardest.
    if (disposed || !acceptsTurn(frame.turnId) || !buffer) {
      return;
    }

    if (activeTurnId !== null && frame.turnId !== activeTurnId) {
      // The server moved to a newer turn without sending flush_audio; the
      // superseded turn must not keep talking over it.
      cutScheduledSources();
    }
    activeTurnId = frame.turnId;
    schedule(frame.turnId, buffer);
  };

  const flush = (turnId: number): void => {
    if (disposed || turnId <= flushedThroughTurnId) {
      return;
    }
    flushedThroughTurnId = turnId;
    if (activeTurnId !== null && activeTurnId <= turnId) {
      cutScheduledSources();
      activeTurnId = null;
    }
  };

  const onDrained = (cb: (turnId: number) => void): void => {
    drainedListeners.add(cb);
  };

  const setDucking = (v: number): void => {
    if (!Number.isFinite(v)) {
      return;
    }
    ducking = Math.min(1, Math.max(0, v));
    if (disposed || muted) {
      // Recorded now, applied when the next turn un-mutes the master.
      return;
    }
    master.gain.cancelScheduledValues(context.currentTime);
    master.gain.setTargetAtTime(ducking, context.currentTime, DUCK_TIME_CONSTANT_SECONDS);
  };

  const scheduledEndTime = (): number => scheduledEnd;

  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    drainedListeners.clear();
    activeTurnId = null;

    if (liveEntries > 0) {
      // Hanging up mid-sentence gets the same ramp: an abrupt stop clicks just
      // as loudly as an interrupt does.
      cutScheduledSources();
    }
    scheduledEnd = 0;
    if (entries.size === 0) {
      safeDisconnect(master);
      return;
    }
    // Otherwise handleEnded disconnects the master once the last cut source ends.
  };

  return { enqueue, flush, onDrained, setDucking, scheduledEndTime, dispose };
};
