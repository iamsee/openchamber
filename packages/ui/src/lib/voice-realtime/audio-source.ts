/**
 * Microphone capture for realtime voice.
 *
 * AudioWorklet capture, not the ScriptProcessorNode the dictation path uses: the
 * worklet resamples and frames on the audio render thread, so the main thread
 * sees ten messages a second instead of running a callback next to React. A
 * main-thread callback drops frames under load and reads as "the VAD is broken"
 * (plan §1, §4). Dictation keeps its ScriptProcessorNode path — this is a second
 * capture path on purpose, not a parameter added to shared code.
 *
 * The mic graph ends at the worklet. It is never connected to
 * `context.destination`, not even through a zero-gain node: the processor has
 * `numberOfOutputs: 0` and is pulled by its input alone, and any mic-to-output
 * path is a feedback loop (plan §4).
 *
 * The AudioContext is shared with playback (audio-context.ts) and is NOT closed
 * by `stop()` — closing it would kill playback and the iOS unlock with it.
 *
 * Levels go out by subscription, never through React state: they update ten times
 * a second, and routing that through state re-rendered the dictation overlay at
 * the same rate (use-dictation-audio-source.ts:9-11).
 */

import { getAudioContextConstructor } from './audio-context';
import {
  REALTIME_CAPTURE_PROCESSOR_NAME,
  type CaptureFrameMessage,
} from './capture-frame';
// Bundled as a worker entry so the module ships as plain JavaScript in both dev
// and production builds; `?url` alone would serve the raw TypeScript.
import captureProcessorUrl from './capture-processor.worklet.ts?worker&url';

export interface RealtimeCaptureOptions {
  context: AudioContext;
  /** Exactly 1600 samples at 16 kHz (100 ms). Called on the main thread; must not throw. */
  onFrame: (pcm16: Int16Array) => void;
  /** Normalized 0..1 level for the primary consumer. Extra consumers use `subscribeLevel`. */
  onLevel?: (level: number) => void;
}

export interface RealtimeCaptureHandle {
  /** Release the mic graph and the media tracks. Idempotent. Does not close the shared context. */
  stop(): void;
  /**
   * Subscribe to the normalized (0..1) mic level, emitted once per 100 ms frame.
   * Returns an unsubscribe. This is the only way to observe the mic after
   * `startRealtimeCapture` has returned, which is what echo calibration measures
   * through.
   */
  subscribeLevel(listener: (level: number) => void): () => void;
}

export const isRealtimeCaptureSupported = (): boolean => {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false;
  }
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    return false;
  }
  const AudioContextCtor = getAudioContextConstructor();
  if (!AudioContextCtor) {
    return false;
  }
  // AudioWorklet is the point of this module: there is no fallback path, because
  // the ScriptProcessorNode fallback is exactly what is being replaced.
  return typeof window.AudioWorkletNode === 'function' && 'audioWorklet' in AudioContextCtor.prototype;
};

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

const stopTracks = (stream: MediaStream): void => {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // A track the platform already ended still has to be walked past.
    }
  }
};

const closePort = (port: MessagePort): void => {
  try {
    port.close();
  } catch {
    // Closing an already-closed port is the normal repeat-stop case.
  }
};

// The processor module is registered per AudioContext, and registering the same
// name twice throws — so the load is memoized against the shared context.
const workletModules = new WeakMap<AudioContext, Promise<void>>();

const ensureCaptureProcessor = (context: AudioContext): Promise<void> => {
  const existing = workletModules.get(context);
  if (existing) {
    return existing;
  }
  const loading = context.audioWorklet.addModule(captureProcessorUrl).catch((error: unknown) => {
    // A failed load must not be memoized, or capture stays broken for the
    // lifetime of the shared context.
    workletModules.delete(context);
    throw error instanceof Error ? error : new Error(String(error));
  });
  workletModules.set(context, loading);
  return loading;
};

export const startRealtimeCapture = async (options: RealtimeCaptureOptions): Promise<RealtimeCaptureHandle> => {
  const { context, onFrame, onLevel } = options;

  if (!isRealtimeCaptureSupported()) {
    throw new Error('[voice-realtime] AudioWorklet microphone capture is not supported in this environment');
  }
  const mediaDevices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
  if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
    throw new Error('[voice-realtime] microphone capture is unavailable in this environment');
  }

  const stream = await mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      // AGC off: it moves the gain continuously, so no fixed voice threshold can
      // mean anything (plan §1). Echo cancellation stays on — it is the only AEC
      // available, and calibration measures how much it actually helps. Noise
      // suppression off: the server runs its own adaptive noise floor and needs
      // to see the real signal.
      echoCancellation: true,
      autoGainControl: false,
      noiseSuppression: false,
    },
  });

  const levelListeners = new Set<(level: number) => void>();
  if (onLevel) {
    levelListeners.add(onLevel);
  }
  const emitLevel = (level: number): void => {
    for (const listener of levelListeners) {
      listener(level);
    }
  };

  let source: MediaStreamAudioSourceNode | null = null;
  let worklet: AudioWorkletNode | null = null;
  let stopped = false;

  const releaseGraph = (): void => {
    if (worklet) {
      worklet.port.onmessage = null;
      closePort(worklet.port);
      safeDisconnect(worklet);
      worklet = null;
    }
    safeDisconnect(source);
    source = null;
    stopTracks(stream);
  };

  try {
    // A suspended context delivers nothing to the worklet. Resuming outside a
    // gesture is refused on iOS, which is why the caller unlocks inside the tap
    // that starts the session (audio-context.ts); this covers desktop autoplay.
    if (context.state !== 'running') {
      await context.resume().catch(() => undefined);
    }
    await ensureCaptureProcessor(context);

    source = context.createMediaStreamSource(stream);
    worklet = new AudioWorkletNode(context, REALTIME_CAPTURE_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions: { sampleRate: context.sampleRate },
    });
    worklet.port.onmessage = (event: MessageEvent<CaptureFrameMessage>) => {
      if (stopped) {
        return;
      }
      emitLevel(event.data.level);
      onFrame(event.data.pcm16);
    };

    // Mic -> worklet, and that is the whole graph. See the module header.
    source.connect(worklet);
  } catch (error) {
    releaseGraph();
    emitLevel(0);
    throw error instanceof Error ? error : new Error(String(error));
  }

  return {
    stop: () => {
      if (stopped) {
        return;
      }
      stopped = true;
      releaseGraph();
      // The meter has to fall to zero, or the panel keeps showing the last level
      // of a session that is already over.
      emitLevel(0);
      levelListeners.clear();
    },
    subscribeLevel: (listener: (level: number) => void) => {
      levelListeners.add(listener);
      return () => {
        levelListeners.delete(listener);
      };
    },
  };
};
