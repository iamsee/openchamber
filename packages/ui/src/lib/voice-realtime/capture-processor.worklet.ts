/**
 * AudioWorklet processor for realtime voice capture.
 *
 * 128-sample quanta at the context's hardware rate go in; exact 1600-sample
 * (100 ms) Int16 frames at 16 kHz come out over `port.postMessage`. The framing
 * runs here rather than in a ScriptProcessorNode callback because that callback
 * runs on the main thread, next to React, and drops frames under load — which
 * reads as "the VAD is broken" rather than as a client bug (plan §1, §4).
 *
 * The node is created with `numberOfOutputs: 0` and is never connected to
 * `context.destination`, not even through a zero-gain node: a 0-output worklet
 * is pulled by its input alone, and any mic-to-output path is an acoustic
 * feedback loop (plan §4).
 */

import {
  createPcm16Framer,
  REALTIME_CAPTURE_PROCESSOR_NAME,
  type CaptureFrameMessage,
  type Pcm16Framer,
} from './capture-frame';

// TypeScript ships no lib for the AudioWorklet global scope, so the two globals
// this file needs are declared here. They exist only inside the worklet.
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void;

const hasSampleRate = (value: unknown): value is { sampleRate: unknown } =>
  typeof value === 'object' && value !== null && 'sampleRate' in value;

/**
 * The context rate is passed in rather than read from the worklet's `sampleRate`
 * global so the resampler is driven by the value the caller's AudioContext
 * actually reported — one source of truth for the ratio.
 */
const readInputSampleRate = (options?: AudioWorkletNodeOptions): number => {
  const processorOptions: unknown = options?.processorOptions;
  const sampleRate = hasSampleRate(processorOptions) ? processorOptions.sampleRate : undefined;
  if (typeof sampleRate !== 'number' || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error('[voice-realtime] capture processor needs processorOptions.sampleRate');
  }
  return sampleRate;
};

class RealtimeCaptureProcessor extends AudioWorkletProcessor {
  private readonly framer: Pcm16Framer;

  constructor(options?: AudioWorkletNodeOptions) {
    super();
    const inputSampleRate = readInputSampleRate(options);
    this.framer = createPcm16Framer({
      inputSampleRate,
      onFrame: (pcm16, level) => {
        const message: CaptureFrameMessage = { pcm16, level };
        // Transfer the frame instead of copying it: 3.2 KB ten times a second
        // into the main thread's heap is the GC pressure this worklet exists to
        // avoid. The framer allocates a fresh buffer for every frame.
        this.port.postMessage(message, [pcm16.buffer]);
      },
    });
  }

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (channel) {
      this.framer.push(channel);
    }
    // Returning true keeps the processor alive for the lifetime of the node;
    // false would let the graph release it in the middle of a call.
    return true;
  }
}

registerProcessor(REALTIME_CAPTURE_PROCESSOR_NAME, RealtimeCaptureProcessor);
