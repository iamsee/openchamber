/**
 * Voice activity detector for the realtime voice turn-taking loop.
 *
 * Pure: no I/O, no timers, no globals. One instance per connection; frames are
 * pushed in and turn-taking events come back.
 *
 * The decision threshold is an ADAPTIVE noise floor — the 20th percentile of
 * recent non-speech frame RMS, smoothed — multiplied by K, never a static peak
 * level. Capture runs with `autoGainControl: false` on the client, but even
 * without AGC the acoustic environment (fan noise, HVAC, other voices) moves
 * the floor across a conversation, so any fixed number would ship as either
 * "VAD never fires" or "VAD fires on nothing" reports.
 *
 * Two speech-start thresholds exist for one reason: while the assistant is
 * speaking, its own audio may reach the mic (iOS has no usable AEC), so the
 * barge-in threshold is far above the room noise floor. While listening, the
 * ordinary low threshold handles turn initiation. Commit-VAD (speculative /
 * real endpoint detection) runs only while LISTENING; in SPEAKING mode only
 * the barge-in detector is live.
 *
 * `carryForward()` clears per-episode latches but KEEPS the floor history, so
 * a barge-in starts the new user turn with a calibrated floor (and the frozen
 * floor is not polluted by remaining TTS echo going into it).
 */

const DEFAULTS = {
  sampleRate: 16000,
  frameMs: 100,
  speechStartMs: 300,
  speculativeSilenceMs: 300,
  commitSilenceMs: 700,
  bargeInMs: 200,
  // Turn initiation: onset threshold = max(smoothedFloor, minFloor) * floorK.
  floorK: 4,
  // Barge-in: the assistant's own audio may reach the mic, so the bar for
  // treating energy as user speech is much higher.
  bargeInFloorK: 10,
  // Absolute minimum for the noise floor (normalized RMS, 0..1). Guards
  // against a digitally silent room producing a zero percentile where every
  // quantum of noise crosses the threshold.
  minFloor: 0.0015,
  // Hysteresis: once in speech, frames must fall below onset * releaseFactor
  // to count as silence, so speech decay does not chatter the voiced flag.
  releaseFactor: 0.6,
  // Slow noise floor: 20th percentile of the last 15 s of non-speech RMS, with
  // exponential smoothing so it cannot jump on a burst.
  floorPercentile: 0.2,
  floorWindowMs: 15000,
  floorAlpha: 0.05,
  // Cold start: with no history yet the floor is the minimum, so the first
  // frame of a loud room would cross the onset threshold, latch `inSpeech`, and
  // then never contribute to the floor — leaving the detector permanently
  // trigger-happy for that connection. While the window is still filling, learn
  // from every frame before deciding voicing.
  floorWarmupMs: 1000,
};

export const VAD_MODE_IDLE = 'idle';
export const VAD_MODE_LISTENING = 'listening';
export const VAD_MODE_SPEAKING = 'speaking';

/**
 * Return an Int16Array view over a PCM16LE buffer, copying when the buffer's
 * byteOffset is not 2-byte aligned (Int16Array requires an even start offset).
 * Mirrors `toInt16Samples` in ../dictation/audio.js, which is private.
 * @param {Buffer} pcm16le
 * @returns {Int16Array}
 */
function toInt16Samples(pcm16le) {
  if (pcm16le.byteOffset % 2 !== 0) {
    const copy = Buffer.from(pcm16le);
    return new Int16Array(copy.buffer, copy.byteOffset, copy.byteLength / 2);
  }
  return new Int16Array(pcm16le.buffer, pcm16le.byteOffset, pcm16le.byteLength / 2);
}

/**
 * Normalized root-mean-square of a PCM16LE frame, in the 0..1 float-domain.
 * @param {Buffer} pcm16le
 * @returns {number}
 */
function pcm16leRms(pcm16le) {
  if (!pcm16le || pcm16le.length === 0) {
    return 0;
  }
  const samples = toInt16Samples(pcm16le);
  if (samples.length === 0) {
    return 0;
  }
  let acc = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i] / 32768;
    acc += v * v;
  }
  return Math.sqrt(acc / samples.length);
}

const percentileOf = (values, percentile) => {
  const sorted = Float64Array.from(values).sort();
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor(percentile * (sorted.length - 1))));
  return sorted[index] ?? 0;
};

/**
 * @param {object} [options]
 * @param {number} [options.sampleRate]
 * @param {number} [options.frameMs]
 * @param {number} [options.speechStartMs] ms of sustained onset before a turn starts
 * @param {number} [options.speculativeSilenceMs] ms of silence after speech for the speculative commit
 * @param {number} [options.commitSilenceMs] ms of silence after speech for the real commit
 * @param {number} [options.bargeInMs] ms of sustained loud energy while SPEAKING for barge-in
 * @param {number} [options.floorK]
 * @param {number} [options.bargeInFloorK]
 * @param {number} [options.minFloor]
 * @param {number} [options.releaseFactor]
 * @param {number} [options.floorPercentile]
 * @param {number} [options.floorWindowMs]
 * @param {number} [options.floorAlpha]
 */
export function createVad(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const frameSamples = Math.max(1, Math.round((cfg.sampleRate * cfg.frameMs) / 1000));
  const frameBytes = frameSamples * 2;
  const speechStartFrames = Math.max(1, Math.round(cfg.speechStartMs / cfg.frameMs));
  const speculativeFrames = Math.max(1, Math.round(cfg.speculativeSilenceMs / cfg.frameMs));
  const commitFrames = Math.max(1, Math.round(cfg.commitSilenceMs / cfg.frameMs));
  const bargeInFramesNeeded = Math.max(1, Math.round(cfg.bargeInMs / cfg.frameMs));
  const floorWindowFrames = Math.max(10, Math.round(cfg.floorWindowMs / cfg.frameMs));
  const floorWarmupFrames = Math.max(1, Math.round(cfg.floorWarmupMs / cfg.frameMs));

  let mode = VAD_MODE_LISTENING;
  let carry = Buffer.alloc(0);

  let rmsHistory = [];
  let smoothedFloor = cfg.minFloor;
  let floorSeeded = false;

  let inSpeech = false;
  let voicedFrames = 0;
  let silenceFrames = 0;
  let speculativeFired = false;
  let endpointFired = false;

  let bargeInFrames = 0;
  let bargeInFired = false;

  const thresholds = () => {
    const base = Math.max(smoothedFloor, cfg.minFloor);
    return {
      onset: base * cfg.floorK,
      release: base * cfg.floorK * cfg.releaseFactor,
      bargeIn: base * cfg.bargeInFloorK,
    };
  };

  const updateFloor = (rms) => {
    rmsHistory.push(rms);
    while (rmsHistory.length > floorWindowFrames) {
      rmsHistory.shift();
    }
    const target = percentileOf(rmsHistory, cfg.floorPercentile);
    if (!floorSeeded) {
      // Bootstrap: first estimate snaps to the measured percentile so the
      // window does not have to fill before the floor is meaningful.
      smoothedFloor = target;
      floorSeeded = true;
      return;
    }
    smoothedFloor += (target - smoothedFloor) * cfg.floorAlpha;
  };

  const clearEpisode = () => {
    inSpeech = false;
    voicedFrames = 0;
    silenceFrames = 0;
    speculativeFired = false;
    endpointFired = false;
    bargeInFrames = 0;
    bargeInFired = false;
  };

  const processListeningFrame = (rms, out) => {
    const warming = rmsHistory.length < floorWarmupFrames;
    if (warming) {
      updateFloor(rms);
    }
    const { onset, release } = thresholds();
    if (rms >= onset) {
      out.voiced = true;
      voicedFrames += 1;
      silenceFrames = 0;
      if (!inSpeech && voicedFrames >= speechStartFrames) {
        inSpeech = true;
        out.speechStarted = true;
      }
      return;
    }
    voicedFrames = 0;
    // Floor learning happens off non-speech frames only: while a speech
    // episode is running the frames are the user's voice, and feeding them
    // into the percentile would drag the threshold up under sustained speech.
    if (!inSpeech) {
      if (!warming) {
        updateFloor(rms);
      }
      return;
    }
    if (rms <= release) {
      silenceFrames += 1;
    } else {
      // Hysteresis zone: hold, decay does not re-arm anything.
      return;
    }
    if (!speculativeFired && silenceFrames >= speculativeFrames) {
      speculativeFired = true;
      out.speculativeEndpoint = true;
    }
    if (!endpointFired && silenceFrames >= commitFrames) {
      endpointFired = true;
      out.endpoint = true;
      inSpeech = false;
      voicedFrames = 0;
      silenceFrames = 0;
      speculativeFired = false;
      endpointFired = false;
    }
  };

  const processSpeakingFrame = (rms, out) => {
    // The floor is frozen while SPEAKING: the assistant's own audio must not
    // raise the baseline that the barge-in detector is measured against.
    if (rms >= thresholds().bargeIn) {
      out.voiced = true;
      bargeInFrames += 1;
    } else {
      bargeInFrames = 0;
    }
    if (!bargeInFired && bargeInFrames >= bargeInFramesNeeded) {
      bargeInFired = true;
      out.bargeIn = true;
    }
  };

  const processFrame = (frame, out) => {
    const rms = pcm16leRms(frame);
    if (mode === VAD_MODE_SPEAKING) {
      processSpeakingFrame(rms, out);
      return;
    }
    if (mode === VAD_MODE_IDLE) {
      return;
    }
    processListeningFrame(rms, out);
  };

  return {
    /** Frame size this instance processes, in BYTES of PCM16LE. */
    frameBytes,
    /** «mode» getter for introspection/tests. */
    get mode() {
      return mode;
    },
    /** Current smoothed noise floor (normalized RMS). */
    get floor() {
      return smoothedFloor;
    },
    /**
     * Switch detector behaviour. LISTENING: onset + speculative + commit VAD;
     * SPEAKING: barge-in detector only, floor frozen; IDLE: all gates off.
     */
    setMode(nextMode) {
      if (nextMode === mode) {
        return;
      }
      if (nextMode !== VAD_MODE_IDLE && nextMode !== VAD_MODE_LISTENING && nextMode !== VAD_MODE_SPEAKING) {
        throw new Error(`unknown VAD mode: ${String(nextMode)}`);
      }
      mode = nextMode;
      if (mode === VAD_MODE_IDLE) {
        clearEpisode();
      }
    },
    /**
     * Push PCM16LE audio. Any buffer length is accepted; partial frames are
     * carried into the next push. Returns the OR of the per-frame events over
     * every complete frame in this push.
     * @param {Buffer} pcm16le
     * @returns {{
     *   voiced: boolean,
     *   speechStarted: boolean,
     *   speculativeEndpoint: boolean,
     *   endpoint: boolean,
     *   bargeIn: boolean,
     * }}
     */
    push(pcm16le) {
      const out = {
        voiced: false,
        speechStarted: false,
        speculativeEndpoint: false,
        endpoint: false,
        bargeIn: false,
      };
      const buf = carry.length > 0 ? Buffer.concat([carry, pcm16le]) : pcm16le;
      const frameCount = Math.floor(buf.length / frameBytes);
      let offset = 0;
      for (let i = 0; i < frameCount; i += 1) {
        processFrame(buf.subarray(offset, offset + frameBytes), out);
        offset += frameBytes;
      }
      carry = buf.subarray(offset);
      if (carry.length > 0) {
        carry = Buffer.from(carry);
      }
      return out;
    },
    /**
     * Start a fresh turn mid-stream. Clears per-episode latches so the next
     * turn can report speechStarted/endpoints again, but KEEPS the adaptive
     * noise floor — after a barge-in the floor is the calibrated one from
     * before the assistant started speaking, and the remaining TTS echo biased
     * against re-triggering costs a barge-in, not the other way around. The
     * residual sample carry is dropped so turn audio starts on a clean frame.
     */
    carryForward() {
      clearEpisode();
      carry = Buffer.alloc(0);
    },
    /** Full reset, including the noise floor history. */
    reset() {
      clearEpisode();
      carry = Buffer.alloc(0);
      rmsHistory = [];
      smoothedFloor = cfg.minFloor;
      floorSeeded = false;
    },
  };
}
