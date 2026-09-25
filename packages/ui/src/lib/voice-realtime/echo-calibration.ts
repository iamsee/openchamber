/**
 * Per-device echo calibration (plan §1 pre-flight, §4, §7 row 1).
 *
 * Full-duplex barge-in is only safe when the assistant's own voice comes back
 * into the microphone below the level the server's VAD would call speech. That
 * return level is a property of the device — speaker and mic geometry, OS echo
 * cancellation, and on iOS possibly an earpiece route instead of the loudspeaker
 * — and cannot be reasoned about from JavaScript. So it is measured: play about a
 * second of TTS while the user is expected to be silent, and watch the mic level
 * during playback plus a 200 ms tail for the room to stop ringing.
 *
 * An ambient window is measured first and removed in energy, so a noisy room does
 * not read as echo and a quiet room does not hide it. The result is the number the
 * UI needs to decide between full-duplex and push-to-talk, and the same two fields
 * the server echoes back in its `calibration` control frame.
 *
 * The caller owns both inputs: a running capture (whose level subscription this
 * measures through) and a `playSample` that plays the probe and resolves when
 * playback has finished. Nothing here starts or stops them.
 */

import type { RealtimeCaptureHandle } from './audio-source';

export interface EchoCalibrationResult {
  /** Mic level attributable to the assistant's own voice, in the capture's normalized 0..1 scale. */
  echoPeak: number;
  /** False means barge-in would fire on the assistant's own audio: offer push-to-talk. */
  fullDuplexSafe: boolean;
}

/** Quiet window before the probe. Levels arrive at 10 Hz, so this is ~3 frames. */
const AMBIENT_WINDOW_MS = 300;
/** Echo tail after `playSample` resolves — reverb and speaker decay outlast the audio. */
const TAIL_WINDOW_MS = 200;

/**
 * Highest echo level that still leaves the user's speech separable from the
 * assistant's own voice, in the same normalized units as the capture level meter
 * (raw RMS × 2). 0.04 normalized is 0.02 raw RMS, about -34 dBFS: a normal
 * speaking voice sits roughly 14 dB above that, which is the margin the server's
 * adaptive noise floor needs to keep barge-in from firing on TTS. Above it, the
 * honest answer is that this device cannot do full duplex.
 */
export const FULL_DUPLEX_SAFE_ECHO_PEAK = 0.04;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const measurePeakWhile = async (
  capture: RealtimeCaptureHandle,
  run: () => Promise<void>,
): Promise<number> => {
  let peak = 0;
  const unsubscribe = capture.subscribeLevel((level) => {
    if (level > peak) {
      peak = level;
    }
  });
  try {
    await run();
  } finally {
    unsubscribe();
  }
  return peak;
};

export const calibrateEcho = async (options: {
  capture: RealtimeCaptureHandle;
  playSample: () => Promise<void>;
}): Promise<EchoCalibrationResult> => {
  const { capture, playSample } = options;

  const ambientPeak = await measurePeakWhile(capture, () => delay(AMBIENT_WINDOW_MS));
  const playbackPeak = await measurePeakWhile(capture, async () => {
    await playSample();
    await delay(TAIL_WINDOW_MS);
  });

  // Uncorrelated signals add in energy, not in amplitude, so the echo alone is the
  // difference of the squares. Subtracting the levels directly would over-report
  // echo in a quiet room and under-report it in a loud one.
  const echoEnergy = playbackPeak * playbackPeak - ambientPeak * ambientPeak;
  const echoPeak = Math.min(1, Math.sqrt(Math.max(0, echoEnergy)));

  return { echoPeak, fullDuplexSafe: echoPeak <= FULL_DUPLEX_SAFE_ECHO_PEAK };
};
