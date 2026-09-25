/**
 * Per-connection realtime voice state machine.
 *
 * States: IDLE (not started) → LISTENING (mic live, turn detection on) →
 * THINKING (STT/LLM in flight) → SPEAKING (TTS audio on the wire). Barge-in
 * returns to LISTENING from THINKING or SPEAKING without passing through IDLE.
 *
 * Three invariants hold this together, and each one exists because violating it
 * is an audible bug rather than a crash:
 *
 * 1. `turnId` is a monotonically increasing integer, bumped on every new turn
 *    and on every barge-in. It is checked after EVERY await boundary and gated
 *    at the audio send site, so work belonging to an interrupted turn can never
 *    write to the socket.
 * 2. `flush_audio` is sent FIRST and synchronously on barge-in, before any
 *    abort or state teardown. The client stops playback the moment it arrives;
 *    anything sent afterwards would race the interrupt.
 * 3. The STT buffer is owned here, not by `lib/dictation`. That module's
 *    `commit()` zeroes its PCM buffer, which makes a speculative commit (decode
 *    at ~300 ms of silence, keep recording, commit for real at ~700 ms)
 *    impossible. `transcribeAudio` from `../tts/stt.js` is called directly.
 */

import {
  parsePcmRateFromFormat,
  pcm16lePeakAbs,
  pcm16ToWav,
  Pcm16MonoResampler,
} from '../dictation/audio.js';
import { transcribeAudio } from '../tts/stt.js';

import {
  createBrain,
  BRAIN_MODE_ASSISTANT,
  VoiceRealtimeNotImplementedError,
} from './brain.js';
import {
  encodeControl,
  encodeServerAudio,
  VOICE_REALTIME_AUDIO_FORMAT_MP3,
  VOICE_REALTIME_AUDIO_FORMAT_PCM16,
  VOICE_REALTIME_MIC_FRAME_MS,
  VOICE_REALTIME_MIC_SAMPLE_RATE,
} from './protocol.js';
import { createSentenceChunker } from './sentence-chunker.js';
import { createTtsSynthesizer, TTS_RESPONSE_FORMAT_WAV } from './tts.js';
import { createVad, VAD_MODE_IDLE, VAD_MODE_LISTENING, VAD_MODE_SPEAKING } from './vad.js';

export const VOICE_STATE_IDLE = 'IDLE';
export const VOICE_STATE_LISTENING = 'LISTENING';
export const VOICE_STATE_THINKING = 'THINKING';
export const VOICE_STATE_SPEAKING = 'SPEAKING';

/**
 * Non-secret defaults. API keys are never defaulted here: they arrive in the
 * client's `start.config` from the settings store, or fall back to
 * `OPENAI_API_KEY` the same way `../tts/stt.js` does.
 */
export const REALTIME_VOICE_DEFAULTS = {
  brain: BRAIN_MODE_ASSISTANT,
  provider: {
    url: 'https://langfuse-relayx.isvbytes.com/v1',
    model: 'deepseek-v4-flash-0731',
  },
  stt: {
    url: 'http://10.10.10.100:30097/v1',
    model: 'SenseVoiceSmall',
    language: 'zh',
    format: 'audio/pcm;rate=16000;bits=16',
  },
  tts: {
    url: 'http://10.10.10.100:30097/v1',
    model: 'kokoro',
    voice: 'zf_001',
    responseFormat: TTS_RESPONSE_FORMAT_WAV,
  },
};

const RING_BUFFER_MS = 1500;
const PRE_ROLL_MS = 250;
const SILENCE_PEAK_FLOOR = 300;
const MAX_HISTORY_MESSAGES = 20;

const BACKPRESSURE_LIMIT_BYTES = 1_000_000;
const DRAIN_POLL_MS = 20;
const DRAIN_TIMEOUT_MS = 10_000;

const STT_SUPERSEDED_CODE = 'stt_superseded';

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const sttSupersededError = () => {
  const error = new Error('STT job superseded by a newer commit');
  error.reasonCode = STT_SUPERSEDED_CODE;
  error.superseded = true;
  error.retryable = false;
  return error;
};

/**
 * Single-slot serialiser for STT work.
 *
 * At most one transcription is in flight and at most one is queued; enqueuing
 * while a job is already queued CANCELS the queued-but-unstarted one. Aborting
 * an in-flight request does not free the inference backend's CPU, so the only
 * reliable protection against a backlog of stale decodes is never letting them
 * start. Speculative commits make this common: a speculative decode is usually
 * still queued or in flight when the real commit lands.
 */
export function createSttSerialiser() {
  let running = null;
  let queued = null;

  const pump = () => {
    if (running || !queued) {
      return;
    }
    const entry = queued;
    queued = null;
    running = entry;
    let settled = false;
    const finish = (settle, value) => {
      if (settled) {
        return;
      }
      settled = true;
      running = null;
      settle(value);
      pump();
    };
    Promise.resolve()
      .then(() => entry.task(entry.controller.signal))
      .then(
        (value) => finish(entry.resolve, value),
        (error) => finish(entry.reject, error),
      );
  };

  return {
    /**
     * @param {(signal: AbortSignal) => Promise<string>} task
     * @returns {Promise<string>}
     */
    run(task) {
      return new Promise((resolve, reject) => {
        if (queued) {
          const dropped = queued;
          queued = null;
          dropped.controller.abort(sttSupersededError());
          dropped.reject(sttSupersededError());
        }
        queued = { task, controller: new AbortController(), resolve, reject };
        pump();
      });
    },
    /** Abort the in-flight job without touching the queue. */
    abortRunning(reason) {
      running?.controller.abort(reason ?? sttSupersededError());
    },
    /** Abort in-flight work and drop the queue (barge-in / teardown). */
    cancelAll(reason) {
      if (queued) {
        const dropped = queued;
        queued = null;
        dropped.controller.abort(reason ?? sttSupersededError());
        dropped.reject(reason ?? sttSupersededError());
      }
      running?.controller.abort(reason ?? sttSupersededError());
    },
    get busy() {
      return running !== null || queued !== null;
    },
  };
}

/**
 * Fixed-capacity PCM ring. Always filling, so a barge-in can seed the new turn
 * with audio from before the VAD onset — otherwise the first syllable of every
 * interruption is eaten.
 */
function createPcmRing(capacityBytes) {
  const chunks = [];
  let total = 0;

  return {
    push(chunk) {
      if (!chunk || chunk.length === 0) {
        return;
      }
      chunks.push(chunk);
      total += chunk.length;
      while (total > capacityBytes && chunks.length > 1) {
        total -= chunks[0].length;
        chunks.shift();
      }
    },
    takeLast(bytes) {
      if (bytes <= 0 || total === 0) {
        return Buffer.alloc(0);
      }
      if (total <= bytes) {
        return Buffer.concat(chunks, total);
      }
      let needed = bytes;
      const tail = [];
      for (let i = chunks.length - 1; i >= 0; i -= 1) {
        tail.unshift(chunks[i]);
        needed -= chunks[i].length;
        if (needed <= 0) {
          break;
        }
      }
      const joined = Buffer.concat(tail);
      return joined.subarray(joined.length - bytes);
    },
    get length() {
      return total;
    },
    clear() {
      chunks.length = 0;
      total = 0;
    },
  };
}

const isAsciiWordChar = (char) => /[A-Za-z0-9]/.test(char);

/**
 * Join two spoken sentences for the transcript history. CJK sentences carry
 * their own terminator and must not gain a space; Latin ones were trimmed by
 * the chunker and need one.
 */
function joinSpoken(accumulated, sentence) {
  if (!accumulated) {
    return sentence;
  }
  const needsSpace = isAsciiWordChar(accumulated[accumulated.length - 1])
    && isAsciiWordChar(sentence[0]);
  return needsSpace ? `${accumulated} ${sentence}` : `${accumulated}${sentence}`;
}

const mergeSection = (base, override) => {
  const out = { ...base };
  if (!override || typeof override !== 'object') {
    return out;
  }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    out[key] = value;
  }
  return out;
};

/**
 * Resolve the effective config for one connection: server defaults, then the
 * client's `start.config`, then per-section overrides.
 * @param {object} serverDefaults
 * @param {object} clientConfig
 */
export function resolveRealtimeVoiceConfig(serverDefaults, clientConfig = {}) {
  const source = clientConfig && typeof clientConfig === 'object' ? clientConfig : {};
  return {
    brain: source.brain === 'session' ? 'session' : serverDefaults.brain,
    sttOnly: source.sttOnly === true,
    provider: mergeSection(serverDefaults.provider, source.provider),
    stt: mergeSection(serverDefaults.stt, source.stt),
    tts: mergeSection(serverDefaults.tts, source.tts),
    calibration: source.calibration && typeof source.calibration === 'object'
      ? {
          echoPeak: Number.isFinite(source.calibration.echoPeak) ? source.calibration.echoPeak : 0,
          fullDuplexSafe: source.calibration.fullDuplexSafe !== false,
        }
      : { echoPeak: 0, fullDuplexSafe: true },
  };
}

/**
 * @param {object} params
 * @param {import('ws').WebSocket} params.socket
 * @param {object} [params.config] server-side defaults; overridden by the client's `start.config`
 * @param {object} [params.deps] injection seam: `{ transcribe, createBrainImpl, createTtsImpl }`
 */
export function createVoiceRealtimeSession({ socket, config = {}, deps = {} }) {
  const transcribe = deps.transcribe ?? transcribeAudio;
  const createBrainImpl = deps.createBrainImpl ?? createBrain;
  const createTtsImpl = deps.createTtsSynthesizer ?? createTtsSynthesizer;
  const serverDefaults = { ...REALTIME_VOICE_DEFAULTS, ...config };

  let resolved = null;
  let started = false;
  let closed = false;
  let sessionId = '';

  let state = VOICE_STATE_IDLE;
  let turnId = 0;
  let turnController = null;
  let committingTurn = 0;

  const vad = createVad({
    sampleRate: VOICE_REALTIME_MIC_SAMPLE_RATE,
    frameMs: VOICE_REALTIME_MIC_FRAME_MS,
  });
  vad.setMode(VAD_MODE_IDLE);

  const ring = createPcmRing(
    Math.round((VOICE_REALTIME_MIC_SAMPLE_RATE * RING_BUFFER_MS) / 1000) * 2,
  );
  const preRollBytes = Math.round((VOICE_REALTIME_MIC_SAMPLE_RATE * PRE_ROLL_MS) / 1000) * 2;

  const sttSerialiser = createSttSerialiser();

  let sttChunks = [];
  let sttBytes = 0;
  let sttResampler = null;
  let sttSampleRate = VOICE_REALTIME_MIC_SAMPLE_RATE;
  // Frozen once an endpoint is detected: trailing silence must not keep growing
  // the buffer, or the speculative transcript could never be reused by the real
  // commit (the byte counts would always differ) and every turn would pay for
  // two decodes instead of one.
  let sttFrozen = false;
  let inTurn = false;
  let speculativeJob = null;

  let history = [];
  let spokenText = '';
  let assistantText = '';
  let sentenceIndex = 0;
  let chunker = createSentenceChunker();
  let lastVoiced = false;
  let brain = null;
  let tts = null;

  const sendControl = (message) => {
    if (closed || socket.readyState !== 1) {
      return false;
    }
    try {
      socket.send(encodeControl(message));
      return true;
    } catch {
      return false;
    }
  };

  const sendError = (error, retryable = true, reasonCode) => {
    sendControl({
      type: 'error',
      error: error?.message || 'Realtime voice failure',
      retryable,
      ...(reasonCode || error?.reasonCode ? { reasonCode: reasonCode || error.reasonCode } : {}),
    });
  };

  const setState = (next) => {
    if (state === next) {
      return;
    }
    state = next;
    if (next === VOICE_STATE_SPEAKING) {
      vad.setMode(VAD_MODE_SPEAKING);
    } else if (next === VOICE_STATE_IDLE) {
      vad.setMode(VAD_MODE_IDLE);
    } else {
      vad.setMode(VAD_MODE_LISTENING);
    }
    sendControl({ type: 'state', state, turnId });
  };

  /**
   * The audio send gate. A frame whose `turnId` is not the current turn belongs
   * to an interrupted reply and must never reach the socket, no matter how far
   * through the synthesis pipeline it got.
   */
  const sendServerAudio = (frame) => {
    if (frame.turnId !== turnId || closed || socket.readyState !== 1) {
      return false;
    }
    try {
      socket.send(
        encodeServerAudio({
          turnId: frame.turnId,
          sentenceIndex: frame.sentenceIndex,
          format: frame.format,
          sampleRate: frame.sampleRate,
          payload: frame.payload,
        }),
      );
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Wait for the socket to drain below the backpressure limit. Audio is 48 KB/s
   * downstream while speaking; a slow client that is not drained would buffer
   * whole sentences in server memory.
   */
  const drainSocket = async () => {
    const startedAt = Date.now();
    while (!closed && socket.readyState === 1 && socket.bufferedAmount > BACKPRESSURE_LIMIT_BYTES) {
      if (Date.now() - startedAt > DRAIN_TIMEOUT_MS) {
        const error = new Error('Client socket is not draining');
        error.reasonCode = 'socket_backpressure';
        error.retryable = true;
        throw error;
      }
      await sleep(DRAIN_POLL_MS);
    }
  };

  const resampleToSttRate = (pcm) => {
    if (sttSampleRate === VOICE_REALTIME_MIC_SAMPLE_RATE) {
      return pcm;
    }
    if (!sttResampler) {
      sttResampler = new Pcm16MonoResampler({
        inputRate: VOICE_REALTIME_MIC_SAMPLE_RATE,
        outputRate: sttSampleRate,
      });
    }
    return sttResampler.processChunk(pcm);
  };

  /**
   * Resample an arbitrary ring-buffer slice with a fresh resampler. The live
   * streaming resampler keeps a carry sample across chunks and cannot be reused
   * for a mid-stream slice without corrupting its state.
   */
  const resampleSlice = (pcm) => {
    if (sttSampleRate === VOICE_REALTIME_MIC_SAMPLE_RATE) {
      return pcm;
    }
    return new Pcm16MonoResampler({
      inputRate: VOICE_REALTIME_MIC_SAMPLE_RATE,
      outputRate: sttSampleRate,
    }).processChunk(pcm);
  };

  const appendSttAudio = (pcm) => {
    if (!inTurn || sttFrozen || pcm.length === 0) {
      return;
    }
    const resampled = resampleToSttRate(pcm);
    if (resampled.length === 0) {
      return;
    }
    sttChunks.push(resampled);
    sttBytes += resampled.length;
  };

  const sttSnapshot = () => (sttChunks.length === 1 ? sttChunks[0] : Buffer.concat(sttChunks, sttBytes));

  const transcribeSnapshot = (signal) => {
    const pcm = sttSnapshot();
    if (pcm.length === 0) {
      return Promise.resolve('');
    }
    // Silence-only audio makes Whisper-style providers hallucinate; the same
    // peak floor the dictation stream manager uses.
    if (pcm16lePeakAbs(pcm) < SILENCE_PEAK_FLOOR) {
      return Promise.resolve('');
    }
    return transcribe({
      audioBuffer: pcm16ToWav(pcm, sttSampleRate),
      mimeType: 'audio/wav',
      model: resolved.stt.model,
      baseURL: resolved.stt.url,
      apiKey: resolved.stt.apiKey,
      language: resolved.stt.language || 'zh',
      signal,
    });
  };

  const resetTurnBuffers = () => {
    sttChunks = [];
    sttBytes = 0;
    sttFrozen = false;
    sttResampler?.reset();
    speculativeJob = null;
  };

  const abortTurn = (reason) => {
    turnController?.abort(reason);
    turnController = null;
    sttSerialiser.cancelAll(reason);
  };

  const beginTurn = ({ seedPreRoll }) => {
    turnId += 1;
    turnController = new AbortController();
    resetTurnBuffers();
    inTurn = true;
    spokenText = '';
    assistantText = '';
    sentenceIndex = 0;
    chunker.reset();
    if (seedPreRoll) {
      const preRoll = ring.takeLast(preRollBytes);
      if (preRoll.length > 0) {
        const resampled = resampleSlice(preRoll);
        sttChunks.push(resampled);
        sttBytes += resampled.length;
      }
    }
    setState(VOICE_STATE_LISTENING);
    return turnId;
  };

  const runSpeculativeCommit = (myTurn) => {
    const snapshotBytes = sttBytes;
    const job = sttSerialiser.run((signal) => transcribeSnapshot(signal));
    speculativeJob = { promise: job, snapshotBytes };
    job.then(
      (text) => {
        if (closed || myTurn !== turnId || !inTurn) {
          return;
        }
        // The buffer grew while the decode was in flight, so this transcript
        // describes audio the user has already continued past. Drop it and let
        // the real commit decode the whole thing.
        if (snapshotBytes !== sttBytes) {
          speculativeJob = null;
          return;
        }
        speculativeJob = { promise: Promise.resolve(text), snapshotBytes, text };
        sendControl({
          type: 'user_text',
          turnId: myTurn,
          text,
          final: false,
          speculative: true,
        });
      },
      (error) => {
        if (speculativeJob?.promise === job) {
          speculativeJob = null;
        }
        if (error?.superseded || error?.name === 'AbortError' || closed || myTurn !== turnId) {
          return;
        }
        sendError(error, true);
      },
    );
  };

  const resolveTranscript = async (myTurn) => {
    if (speculativeJob && speculativeJob.snapshotBytes === sttBytes) {
      if (typeof speculativeJob.text === 'string') {
        return speculativeJob.text;
      }
      return speculativeJob.promise;
    }
    speculativeJob = null;
    return sttSerialiser.run((signal) => transcribeSnapshot(signal));
  };

  const speakSentence = async (sentence, myTurn, signal) => {
    const index = sentenceIndex;
    sentenceIndex += 1;
    let sentAny = false;
    for await (const piece of tts.synthesize(sentence, { signal })) {
      if (myTurn !== turnId || closed) {
        return false;
      }
      await drainSocket();
      if (myTurn !== turnId || closed) {
        return false;
      }
      if (piece.pcm) {
        sentAny = sendServerAudio({
          turnId: myTurn,
          sentenceIndex: index,
          format: VOICE_REALTIME_AUDIO_FORMAT_PCM16,
          sampleRate: piece.sampleRate,
          payload: piece.pcm,
        }) || sentAny;
      } else if (piece.mp3) {
        sentAny = sendServerAudio({
          turnId: myTurn,
          sentenceIndex: index,
          format: VOICE_REALTIME_AUDIO_FORMAT_MP3,
          sampleRate: 0,
          payload: piece.mp3,
        }) || sentAny;
      }
      if (sentAny && state !== VOICE_STATE_SPEAKING) {
        setState(VOICE_STATE_SPEAKING);
      }
    }
    if (!sentAny || myTurn !== turnId) {
      return false;
    }
    spokenText = joinSpoken(spokenText, sentence);
    return true;
  };

  const runAssistantTurn = async (userText, myTurn) => {
    const signal = turnController?.signal;
    if (!signal) {
      return;
    }
    history = [...history, { role: 'user', content: userText }].slice(-MAX_HISTORY_MESSAGES);
    chunker.reset();
    spokenText = '';
    assistantText = '';
    sentenceIndex = 0;

    for await (const delta of brain.stream(history, { signal })) {
      if (myTurn !== turnId || closed) {
        return;
      }
      assistantText += delta;
      sendControl({
        type: 'assistant_text',
        turnId: myTurn,
        delta,
        text: assistantText,
        final: false,
      });
      for (const sentence of chunker.push(delta)) {
        await speakSentence(sentence, myTurn, signal);
        if (myTurn !== turnId || closed) {
          return;
        }
      }
    }
    for (const sentence of chunker.flush()) {
      await speakSentence(sentence, myTurn, signal);
      if (myTurn !== turnId || closed) {
        return;
      }
    }
    if (myTurn !== turnId || closed) {
      return;
    }
    sendControl({
      type: 'assistant_text',
      turnId: myTurn,
      delta: '',
      text: spokenText || assistantText,
      final: true,
    });
    // History records what the user actually heard, not everything the model
    // produced. A reply cut off by barge-in must not claim sentences that were
    // synthesized but never reached the speakers.
    if (spokenText) {
      history = [...history, { role: 'assistant', content: spokenText }].slice(-MAX_HISTORY_MESSAGES);
    }
    // Cleared once the turn is on the record: a `barge_in` arriving after a
    // completed reply (nothing is playing) must not append it a second time.
    spokenText = '';
    assistantText = '';
    await drainSocket();
    if (myTurn !== turnId || closed) {
      return;
    }
    sendControl({ type: 'audio_end', turnId: myTurn });
    inTurn = false;
    resetTurnBuffers();
    setState(VOICE_STATE_LISTENING);
  };

  const commitTurn = async (myTurn) => {
    if (committingTurn === myTurn || myTurn !== turnId || !inTurn) {
      return;
    }
    committingTurn = myTurn;
    sttFrozen = true;
    setState(VOICE_STATE_THINKING);
    try {
      const text = (await resolveTranscript(myTurn)).trim();
      if (myTurn !== turnId || closed) {
        return;
      }
      inTurn = false;
      resetTurnBuffers();
      if (!text) {
        setState(VOICE_STATE_LISTENING);
        return;
      }
      sendControl({
        type: 'user_text',
        turnId: myTurn,
        text,
        final: true,
        speculative: false,
      });
      if (resolved.sttOnly) {
        setState(VOICE_STATE_LISTENING);
        return;
      }
      await runAssistantTurn(text, myTurn);
    } catch (error) {
      if (myTurn !== turnId || closed) {
        return;
      }
      if (error instanceof VoiceRealtimeNotImplementedError) {
        sendError(error, false, error.reasonCode);
      } else if (error?.name !== 'AbortError' && !error?.superseded && !turnController?.signal.aborted) {
        sendError(error, error?.retryable !== false);
      }
      inTurn = false;
      resetTurnBuffers();
      if (!closed && myTurn === turnId) {
        setState(VOICE_STATE_LISTENING);
      }
    } finally {
      if (committingTurn === myTurn) {
        committingTurn = 0;
      }
    }
  };

  const handleBargeIn = () => {
    if (!started || closed) {
      return;
    }
    const interruptedTurn = turnId;
    // Interrupt first: flush_audio goes out synchronously, before turnId is
    // bumped and before anything is aborted, so the client can ramp its master
    // gain down immediately instead of playing the tail of an interrupted reply.
    sendControl({ type: 'flush_audio', turnId: interruptedTurn });
    // Truncation only applies to a reply still being generated. One that already
    // finished is on the record in full, and re-appending it would duplicate the
    // assistant turn in history.
    const turnInFlight = state === VOICE_STATE_SPEAKING || state === VOICE_STATE_THINKING;
    if (turnInFlight && (spokenText || assistantText)) {
      sendControl({
        type: 'assistant_text',
        turnId: interruptedTurn,
        delta: '',
        text: spokenText || assistantText,
        final: true,
      });
    }
    if (turnInFlight && spokenText) {
      history = [...history, { role: 'assistant', content: spokenText }].slice(-MAX_HISTORY_MESSAGES);
    }

    abortTurn(sttSupersededError());
    inTurn = false;
    // carryForward, NOT reset: the adaptive noise floor learned before the
    // assistant started speaking is still the right baseline, and relearning it
    // would leave the next turn with no threshold for a second or two.
    vad.carryForward();
    beginTurn({ seedPreRoll: true });
  };

  const handleStart = (message) => {
    const clientConfig = message.config && typeof message.config === 'object' ? message.config : {};
    resolved = resolveRealtimeVoiceConfig(serverDefaults, clientConfig);
    sessionId = typeof message.sessionId === 'string' && message.sessionId
      ? message.sessionId.slice(0, 128)
      : `vr_${Date.now().toString(36)}`;

    try {
      brain = createBrainImpl({
        mode: resolved.brain,
        baseUrl: resolved.provider.url,
        apiKey: resolved.provider.apiKey,
        model: resolved.provider.model,
      });
      tts = createTtsImpl({
        baseUrl: resolved.tts.url,
        apiKey: resolved.tts.apiKey,
        model: resolved.tts.model,
        voice: resolved.tts.voice,
        responseFormat: resolved.tts.responseFormat,
      });
    } catch (error) {
      started = false;
      if (error instanceof VoiceRealtimeNotImplementedError) {
        sendError(error, false, error.reasonCode);
      } else {
        sendError(error, false, 'invalid_config');
      }
      return;
    }

    sttSampleRate = parsePcmRateFromFormat(resolved.stt.format, VOICE_REALTIME_MIC_SAMPLE_RATE)
      ?? VOICE_REALTIME_MIC_SAMPLE_RATE;
    started = true;
    history = [];
    ring.clear();
    resetTurnBuffers();
    vad.reset();
    sendControl({
      type: 'ready',
      sessionId,
      defaults: {
        brain: resolved.brain,
        provider: { url: resolved.provider.url, model: resolved.provider.model },
        stt: { url: resolved.stt.url, model: resolved.stt.model, format: resolved.stt.format },
        tts: {
          url: resolved.tts.url,
          model: resolved.tts.model,
          voice: resolved.tts.voice,
          responseFormat: resolved.tts.responseFormat,
        },
        micSampleRate: VOICE_REALTIME_MIC_SAMPLE_RATE,
        micFrameMs: VOICE_REALTIME_MIC_FRAME_MS,
        ringBufferMs: RING_BUFFER_MS,
        preRollMs: PRE_ROLL_MS,
      },
    });
    // Echo calibration is measured by the client (it owns the mic and the
    // playback clock). A device that reports full-duplex as unsafe gets no
    // VAD-triggered barge-in: only an explicit `barge_in` control interrupts,
    // so a phone without usable AEC degrades to push-to-talk instead of
    // interrupting itself.
    sendControl({
      type: 'calibration',
      echoPeak: resolved.calibration.echoPeak,
      fullDuplexSafe: resolved.calibration.fullDuplexSafe,
    });
    // turnId stays 0 until the first detected onset: 0 means "no turn yet", and
    // the first real turn is 1.
    setState(VOICE_STATE_LISTENING);
  };

  const handleAudioFrame = (frame) => {
    if (!started || closed) {
      return;
    }
    if (frame.sampleRate !== VOICE_REALTIME_MIC_SAMPLE_RATE) {
      sendError(
        new Error(
          `Expected ${VOICE_REALTIME_MIC_SAMPLE_RATE} Hz mic audio, got ${frame.sampleRate} Hz`,
        ),
        false,
        'mic_sample_rate_mismatch',
      );
      return;
    }
    const pcm = Buffer.isBuffer(frame.pcm) ? frame.pcm : Buffer.from(frame.pcm);
    if (pcm.length === 0 || pcm.length % 2 !== 0) {
      return;
    }

    ring.push(pcm);
    if (inTurn && state !== VOICE_STATE_SPEAKING) {
      appendSttAudio(pcm);
    }

    const events = vad.push(pcm);
    if (events.voiced !== lastVoiced) {
      lastVoiced = events.voiced;
      sendControl({ type: 'vad', voiced: events.voiced });
    }

    if (state === VOICE_STATE_SPEAKING) {
      // No commit VAD while speaking: only the barge-in detector is live, and
      // only when the device's own calibration says full duplex is safe.
      if (events.bargeIn && resolved.calibration.fullDuplexSafe) {
        handleBargeIn();
      }
      return;
    }

    if (state === VOICE_STATE_THINKING) {
      // The user started talking while the reply was still being assembled.
      // Their new turn wins: abort the pending work and listen instead.
      if (events.speechStarted) {
        abortTurn(sttSupersededError());
        inTurn = false;
        beginTurn({ seedPreRoll: true });
      }
      return;
    }

    if (events.speechStarted) {
      beginTurn({ seedPreRoll: true });
      return;
    }

    if (!inTurn) {
      return;
    }
    if (events.speculativeEndpoint) {
      sttFrozen = true;
      if (!speculativeJob) {
        runSpeculativeCommit(turnId);
      }
      return;
    }
    // Speech resumed after a speculative commit: that decode describes a buffer
    // the user has already continued past, so cancel it, unfreeze, and free the
    // serialiser slot for the real commit.
    if (speculativeJob && events.voiced) {
      speculativeJob = null;
      sttFrozen = false;
      sttSerialiser.abortRunning(sttSupersededError());
      return;
    }
    if (events.endpoint) {
      void commitTurn(turnId);
    }
  };

  const cleanup = () => {
    if (closed) {
      return;
    }
    closed = true;
    started = false;
    abortTurn(sttSupersededError());
    inTurn = false;
    vad.setMode(VAD_MODE_IDLE);
    ring.clear();
    resetTurnBuffers();
    history = [];
  };

  return {
    get state() {
      return state;
    },
    get turnId() {
      return turnId;
    },
    get sessionId() {
      return sessionId;
    },
    get started() {
      return started;
    },
    /** Conversation history as it will be sent to the brain. Exposed for tests. */
    get history() {
      return history;
    },
    handleControl(message) {
      if (!message || typeof message !== 'object' || closed) {
        return;
      }
      switch (message.type) {
        case 'start':
          handleStart(message);
          return;
        case 'barge_in':
          handleBargeIn();
          return;
        case 'end_turn':
          if (started && inTurn && committingTurn !== turnId) {
            void commitTurn(turnId);
          }
          return;
        case 'calibration': {
          if (!resolved) {
            return;
          }
          const echoPeak = Number.isFinite(message.echoPeak) ? message.echoPeak : resolved.calibration.echoPeak;
          const fullDuplexSafe = message.fullDuplexSafe !== false;
          resolved.calibration = { echoPeak, fullDuplexSafe };
          sendControl({ type: 'calibration', echoPeak, fullDuplexSafe });
          return;
        }
        case 'stop':
          cleanup();
          try {
            socket.close(1000, 'client requested stop');
          } catch {
            // already closing
          }
          return;
        case 'ping':
          sendControl({ type: 'pong' });
          return;
        default:
      }
    },
    handleAudioFrame,
    cleanup,
  };
}
