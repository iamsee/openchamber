import { describe, expect, test } from 'bun:test';

import { calibrateEcho, FULL_DUPLEX_SAFE_ECHO_PEAK } from './echo-calibration';
import type { RealtimeCaptureHandle } from './audio-source';

interface FakeCapture {
  handle: RealtimeCaptureHandle;
  publish(level: number): void;
  listenerCount(): number;
}

const createFakeCapture = (): FakeCapture => {
  const listeners = new Set<(level: number) => void>();
  return {
    handle: {
      stop: () => undefined,
      subscribeLevel: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    publish: (level) => {
      for (const listener of listeners) {
        listener(level);
      }
    },
    listenerCount: () => listeners.size,
  };
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Levels arrive at 10 Hz in the real capture; 40 ms keeps every window populated. */
const publishLevels = (capture: FakeCapture, levelFor: () => number): { stop(): void } => {
  const timer = setInterval(() => capture.publish(levelFor()), 40);
  return {
    stop: () => clearInterval(timer),
  };
};

describe('calibrateEcho', () => {
  test('reports a loud echo return as unsafe for full duplex', async () => {
    const capture = createFakeCapture();
    let playing = false;
    const levels = publishLevels(capture, () => (playing ? 0.05 : 0.01));

    const result = await calibrateEcho({
      capture: capture.handle,
      playSample: async () => {
        playing = true;
        await delay(120);
      },
    });
    levels.stop();

    expect(result.echoPeak).toBeCloseTo(Math.sqrt(0.05 ** 2 - 0.01 ** 2), 6);
    expect(result.echoPeak).toBeGreaterThan(FULL_DUPLEX_SAFE_ECHO_PEAK);
    expect(result.fullDuplexSafe).toBe(false);
    expect(capture.listenerCount()).toBe(0);
  });

  test('reports a quiet return as safe', async () => {
    const capture = createFakeCapture();
    let playing = false;
    const levels = publishLevels(capture, () => (playing ? 0.02 : 0));

    const result = await calibrateEcho({
      capture: capture.handle,
      playSample: async () => {
        playing = true;
        await delay(120);
      },
    });
    levels.stop();

    expect(result.echoPeak).toBeCloseTo(0.02, 6);
    expect(result.fullDuplexSafe).toBe(true);
  });

  test('subtracts the ambient floor in energy, not in amplitude', async () => {
    const capture = createFakeCapture();
    let playing = false;
    const levels = publishLevels(capture, () => (playing ? 0.045 : 0.03));

    const result = await calibrateEcho({
      capture: capture.handle,
      playSample: async () => {
        playing = true;
        await delay(120);
      },
    });
    levels.stop();

    // Amplitude subtraction would report 0.015 here and call a noisy room safe.
    expect(result.echoPeak).toBeCloseTo(Math.sqrt(0.045 ** 2 - 0.03 ** 2), 6);
    expect(result.fullDuplexSafe).toBe(true);
  });

  test('still measures the tail after playback has ended', async () => {
    const capture = createFakeCapture();
    const levels = publishLevels(capture, () => 0);

    const result = await calibrateEcho({
      capture: capture.handle,
      playSample: async () => {
        // Speaker decay and room reverb outlast the last sample.
        void delay(20).then(() => capture.publish(0.3));
      },
    });
    levels.stop();

    expect(result.echoPeak).toBeCloseTo(0.3, 6);
    expect(result.fullDuplexSafe).toBe(false);
  });

  test('clamps a clipping return to full scale', async () => {
    const capture = createFakeCapture();
    let playing = false;
    const levels = publishLevels(capture, () => (playing ? 1 : 0));

    const result = await calibrateEcho({
      capture: capture.handle,
      playSample: async () => {
        playing = true;
        await delay(120);
      },
    });
    levels.stop();

    expect(result.echoPeak).toBe(1);
    expect(result.fullDuplexSafe).toBe(false);
  });

  test('lets a failed probe through and still unsubscribes', async () => {
    const capture = createFakeCapture();
    const failure = new Error('tts unavailable');

    const calibration = calibrateEcho({
      capture: capture.handle,
      playSample: () => Promise.reject(failure),
    });

    await expect(calibration).rejects.toBe(failure);
    expect(capture.listenerCount()).toBe(0);
  });
});
