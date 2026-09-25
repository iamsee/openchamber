import { describe, expect, test } from 'bun:test';

import {
  CAPTURE_LEVEL_GAIN,
  createPcm16Framer,
  floatToPcm16,
  REALTIME_CAPTURE_FRAME_SAMPLES,
  REALTIME_CAPTURE_SAMPLE_RATE,
  type Pcm16Framer,
} from './capture-frame';

const QUANTUM = 128;

interface CollectedCapture {
  frames: Int16Array[];
  levels: number[];
  framer: Pcm16Framer;
  samplesEmitted: () => number;
}

const collect = (inputSampleRate: number): CollectedCapture => {
  const frames: Int16Array[] = [];
  const levels: number[] = [];
  const framer = createPcm16Framer({
    inputSampleRate,
    onFrame: (pcm16, level) => {
      frames.push(pcm16);
      levels.push(level);
    },
  });
  return {
    frames,
    levels,
    framer,
    samplesEmitted: () => frames.reduce((total, frame) => total + frame.length, 0),
  };
};

const constant = (length: number, value: number): Float32Array => new Float32Array(length).fill(value);

const ramp = (length: number, step: number): Float32Array => {
  const samples = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    samples[index] = index * step;
  }
  return samples;
};

/** Feed the framer the way the worklet does: 128-sample render quanta. */
const pushInQuanta = (framer: Pcm16Framer, samples: Float32Array): void => {
  for (let offset = 0; offset < samples.length; offset += QUANTUM) {
    framer.push(samples.subarray(offset, Math.min(offset + QUANTUM, samples.length)));
  }
};

describe('floatToPcm16', () => {
  test('maps full scale to the Int16 range and clamps past it', () => {
    expect(floatToPcm16(0)).toBe(0);
    expect(floatToPcm16(1)).toBe(0x7fff);
    expect(floatToPcm16(-1)).toBe(-0x8000);
    expect(floatToPcm16(2)).toBe(0x7fff);
    expect(floatToPcm16(-2)).toBe(-0x8000);
    expect(floatToPcm16(0.5)).toBe(Math.round(0.5 * 0x7fff));
  });
});

describe('createPcm16Framer', () => {
  test('rejects a sample rate it cannot resample from', () => {
    const onFrame = () => undefined;
    expect(() => createPcm16Framer({ inputSampleRate: 0, onFrame })).toThrow('invalid capture sample rate');
    expect(() => createPcm16Framer({ inputSampleRate: -48000, onFrame })).toThrow('invalid capture sample rate');
    expect(() => createPcm16Framer({ inputSampleRate: Number.NaN, onFrame })).toThrow('invalid capture sample rate');
  });

  test('emits exactly 1600-sample frames from 128-sample quanta at 48 kHz', () => {
    const capture = collect(48000);

    pushInQuanta(capture.framer, constant(48000, 0.25));

    expect(capture.frames).toHaveLength(10);
    for (const frame of capture.frames) {
      expect(frame.length).toBe(REALTIME_CAPTURE_FRAME_SAMPLES);
    }
    expect(capture.samplesEmitted()).toBe(REALTIME_CAPTURE_SAMPLE_RATE);
  });

  test('holds the 100 ms cadence at 44.1 kHz, where the ratio is not an integer', () => {
    const capture = collect(44100);

    pushInQuanta(capture.framer, constant(44100, 0.25));

    expect(capture.frames).toHaveLength(10);
    expect(capture.samplesEmitted()).toBe(REALTIME_CAPTURE_SAMPLE_RATE);
  });

  test('holds the cadence at 24 kHz, where the context is slower than the target', () => {
    const capture = collect(24000);

    pushInQuanta(capture.framer, constant(24000, 0.25));

    expect(capture.frames).toHaveLength(10);
    expect(capture.samplesEmitted()).toBe(REALTIME_CAPTURE_SAMPLE_RATE);
  });

  test('does not drift over ten seconds of 44.1 kHz audio', () => {
    const capture = collect(44100);

    pushInQuanta(capture.framer, constant(441000, 0.1));

    // A per-block resample that rounded each quantum independently would be off by
    // a sample or two per block here — thousands over ten seconds.
    expect(capture.samplesEmitted()).toBe(REALTIME_CAPTURE_SAMPLE_RATE * 10);
  });

  test('buffers a partial frame instead of emitting a short one', () => {
    const capture = collect(48000);

    pushInQuanta(capture.framer, constant(2400, 0.25));
    expect(capture.frames).toHaveLength(0);

    pushInQuanta(capture.framer, constant(2400, 0.25));
    expect(capture.frames).toHaveLength(1);
    expect(capture.frames[0].length).toBe(REALTIME_CAPTURE_FRAME_SAMPLES);
  });

  test('interpolates a ramp exactly, so the resampler adds no offset', () => {
    const capture = collect(48000);
    const step = 1e-5;

    pushInQuanta(capture.framer, ramp(4800, step));

    expect(capture.frames).toHaveLength(1);
    const frame = capture.frames[0];
    for (let index = 0; index < frame.length; index += 1) {
      // ratio 3 keeps every read position on an integer sample with fraction 0.
      expect(frame[index]).toBe(floatToPcm16(index * 3 * step));
    }
  });

  test('keeps interpolated output between its neighbouring input samples', () => {
    const capture = collect(44100);
    const step = 1e-5;

    pushInQuanta(capture.framer, ramp(4410, step));

    const frame = capture.frames[0];
    const ratio = 44100 / REALTIME_CAPTURE_SAMPLE_RATE;
    for (let index = 0; index < frame.length; index += 1) {
      const position = index * ratio;
      const low = floatToPcm16(Math.floor(position) * step);
      const high = floatToPcm16((Math.floor(position) + 1) * step);
      expect(frame[index]).toBeGreaterThanOrEqual(low - 1);
      expect(frame[index]).toBeLessThanOrEqual(high + 1);
    }
  });

  test('reports the frame level in the same normalized units as the dictation meter', () => {
    const capture = collect(48000);

    pushInQuanta(capture.framer, constant(48000, 0.25));

    expect(capture.levels).toHaveLength(10);
    for (const level of capture.levels) {
      expect(level).toBeCloseTo(0.25 * CAPTURE_LEVEL_GAIN, 12);
    }
  });

  test('reports silence as zero and clamps an over-range signal to one', () => {
    const silence = collect(48000);
    pushInQuanta(silence.framer, constant(14400, 0));
    expect(silence.levels).toEqual([0, 0, 0]);

    const loud = collect(48000);
    pushInQuanta(loud.framer, constant(14400, 4));
    expect(loud.levels).toEqual([1, 1, 1]);
    expect(Array.from(loud.frames[0]).every((sample) => sample === 0x7fff)).toBe(true);
  });

  test('hands over a fresh buffer per frame so the worklet can transfer it', () => {
    const capture = collect(48000);

    pushInQuanta(capture.framer, constant(9600, 0.25));

    expect(capture.frames).toHaveLength(2);
    expect(capture.frames[0].buffer).not.toBe(capture.frames[1].buffer);
  });

  test('ignores an empty quantum', () => {
    const capture = collect(48000);

    capture.framer.push(new Float32Array(0));
    pushInQuanta(capture.framer, constant(4800, 0.25));

    expect(capture.frames).toHaveLength(1);
  });
});
