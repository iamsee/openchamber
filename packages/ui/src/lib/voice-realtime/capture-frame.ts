/**
 * Capture contract shared by the AudioWorklet and the main thread, plus the
 * pure framing DSP that runs inside the worklet.
 *
 * The job: turn 128-sample quanta at the context's hardware rate into exact
 * 1600-sample (100 ms) Int16 frames at 16 kHz. The frame size is not a
 * preference — the server VAD counts 100 ms frames (plan §5.1), so a short or
 * long frame shifts every downstream timing decision.
 *
 * Resampling is linear interpolation with a fractional cursor carried across
 * blocks, which is what the shipped dictation capture does
 * (use-dictation-audio-source.ts:46-69). There is no anti-alias filter: the only
 * consumer is STT, and the decimation of voice-band audio is identical to the
 * path already running in production. Carrying the cursor instead of resampling
 * each block independently is what keeps the frame cadence drift-free over a
 * long call — a per-block round would lose or repeat a sample every block at
 * 44.1 kHz (ratio 2.75625).
 *
 * Everything here is pure and allocation-steady so it can run on the audio
 * render thread and be unit-tested on the main one.
 */

/** Output rate of every mic frame; the server expects 16 kHz PCM16LE mono. */
export const REALTIME_CAPTURE_SAMPLE_RATE = 16000;

/** 100 ms at 16 kHz — exactly one wire frame. */
export const REALTIME_CAPTURE_FRAME_SAMPLES = 1600;

/**
 * Processor name registered by capture-processor.worklet.ts and instantiated by
 * audio-source.ts. It lives here, in the one module both sides import, so the
 * two cannot drift apart.
 */
export const REALTIME_CAPTURE_PROCESSOR_NAME = 'openchamber-realtime-capture';

/**
 * Display gain applied to the raw frame RMS, matching the dictation meter
 * (use-dictation-audio-source.ts:217) so both surfaces read the same. Levels are
 * raw RMS × 2 clamped to 0..1 — echo-calibration.ts thresholds are stated in
 * these same normalized units.
 */
export const CAPTURE_LEVEL_GAIN = 2;

/** Worklet -> main thread, one message per 100 ms frame. */
export interface CaptureFrameMessage {
  pcm16: Int16Array;
  level: number;
}

export interface Pcm16Framer {
  /** Consume one render quantum of mono input at the context's sample rate. */
  push(input: Float32Array): void;
}

export const floatToPcm16 = (sample: number): number => {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
};

/**
 * Create a framer that emits complete 1600-sample frames through `onFrame`.
 *
 * `onFrame` is called synchronously from `push`, on the audio render thread when
 * this runs inside the worklet, so it must stay cheap and must not throw.
 * The buffer handed over is owned by the caller — the worklet transfers it.
 */
export const createPcm16Framer = (options: {
  inputSampleRate: number;
  onFrame: (pcm16: Int16Array<ArrayBuffer>, level: number) => void;
}): Pcm16Framer => {
  const { inputSampleRate, onFrame } = options;
  if (!Number.isFinite(inputSampleRate) || inputSampleRate <= 0) {
    throw new Error(`[voice-realtime] invalid capture sample rate: ${inputSampleRate}`);
  }

  const ratio = inputSampleRate / REALTIME_CAPTURE_SAMPLE_RATE;
  const frameSamples = REALTIME_CAPTURE_FRAME_SAMPLES;

  // Unconsumed input samples. Grown on demand, compacted in place, so the steady
  // state allocates nothing per quantum.
  let history = new Float32Array(Math.max(64, Math.ceil(ratio) * 2 + 2));
  let historyLength = 0;
  /** Read position in input samples, fractional part carried across pushes. */
  let phase = 0;

  let frame = new Int16Array(frameSamples);
  let frameOffset = 0;
  let sumSquares = 0;

  const emitFrame = (): void => {
    const level = Math.min(1, Math.sqrt(sumSquares / frameSamples) * CAPTURE_LEVEL_GAIN);
    const completed = frame;
    sumSquares = 0;
    frameOffset = 0;
    frame = new Int16Array(frameSamples);
    onFrame(completed, level);
  };

  const writeSample = (value: number): void => {
    // Clamp before the energy sum as well as the conversion: an out-of-range
    // sample would otherwise inflate the level meter past full scale.
    const clamped = value < -1 ? -1 : value > 1 ? 1 : value;
    sumSquares += clamped * clamped;
    frame[frameOffset] = floatToPcm16(clamped);
    frameOffset += 1;
    if (frameOffset === frameSamples) emitFrame();
  };

  const push = (input: Float32Array): void => {
    if (input.length === 0) return;

    const needed = historyLength + input.length;
    if (needed > history.length) {
      const grown = new Float32Array(Math.max(needed * 2, history.length * 2));
      grown.set(history.subarray(0, historyLength));
      history = grown;
    }
    history.set(input, historyLength);
    historyLength = needed;

    // Interpolation reads index+1, so stop while that neighbour is still inside
    // the buffered input. Whatever is left over stays buffered and `phase` keeps
    // its fractional part, which is what makes the output cadence exact.
    while (phase + 1 < historyLength) {
      const index = Math.floor(phase);
      const fraction = phase - index;
      const low = history[index];
      writeSample(low + (history[index + 1] - low) * fraction);
      phase += ratio;
    }

    // The clamp is load-bearing: the last interpolation step can overshoot the
    // buffered input by up to one ratio, and that overshoot is a read position
    // into samples that have not arrived yet — it belongs in `phase`, not in a
    // negative buffer length.
    const consumed = Math.min(Math.floor(phase), historyLength);
    if (consumed > 0) {
      history.copyWithin(0, consumed, historyLength);
      historyLength -= consumed;
      phase -= consumed;
    }
  };

  return { push };
};
