import { describe, expect, test } from 'bun:test';

import {
  computeChunkStartTime,
  createAudioQueue,
  findNearSilenceWindow,
  pcm16ToFloat32,
} from './audio-queue';
import { TTS_FORMAT_MP3, TTS_FORMAT_PCM16, type InboundAudioFrame } from './protocol';

const CONTEXT_SAMPLE_RATE = 48000;
const TTS_SAMPLE_RATE = 24000;
const FLUSH_GAIN_TIME_CONSTANT_SECONDS = 0.005;

interface FakeParamEvent {
  method: 'cancelScheduledValues' | 'setValueAtTime' | 'setTargetAtTime';
  args: number[];
}

interface FakeParam {
  value: number;
  events: FakeParamEvent[];
  cancelScheduledValues(time: number): FakeParam;
  setValueAtTime(value: number, time: number): FakeParam;
  setTargetAtTime(target: number, time: number, timeConstant: number): FakeParam;
}

interface FakeBuffer {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  duration: number;
  channels: Float32Array<ArrayBuffer>[];
  getChannelData(channel: number): Float32Array<ArrayBuffer>;
  copyToChannel(source: Float32Array<ArrayBuffer>, channel: number): void;
}

interface FakeSource {
  buffer: FakeBuffer | null;
  startedAt: number | null;
  stoppedAt: number | null;
  disconnects: number;
  onended: (() => void) | null;
  start(when?: number): void;
  stop(when?: number): void;
  connect(target: unknown): unknown;
  disconnect(): void;
  fireEnded(): void;
}

interface FakeGain {
  gain: FakeParam;
  disconnects: number;
  connect(target: unknown): unknown;
  disconnect(): void;
}

interface FakeContext {
  currentTime: number;
  sampleRate: number;
  destination: { readonly kind: 'destination' };
  /** Ordered cross-node log, so "ramp before stop" can be asserted as an order. */
  log: string[];
  gains: FakeGain[];
  sources: FakeSource[];
  buffers: FakeBuffer[];
  decodeRequests: number;
  heldDecodes: Array<(buffer: FakeBuffer) => void>;
  createGain(): FakeGain;
  createBuffer(channels: number, length: number, sampleRate: number): FakeBuffer;
  createBufferSource(): FakeSource;
  decodeAudioData(data: ArrayBuffer): Promise<FakeBuffer>;
}

const createContext = (options: { currentTime?: number; holdDecodes?: boolean } = {}): FakeContext => {
  const log: string[] = [];
  const gains: FakeGain[] = [];
  const sources: FakeSource[] = [];
  const buffers: FakeBuffer[] = [];
  const heldDecodes: Array<(buffer: FakeBuffer) => void> = [];

  const createParam = (owner: string, initial: number): FakeParam => {
    const param: FakeParam = {
      value: initial,
      events: [],
      cancelScheduledValues: (time) => {
        param.events.push({ method: 'cancelScheduledValues', args: [time] });
        log.push(`${owner}:cancelScheduledValues`);
        return param;
      },
      setValueAtTime: (value, time) => {
        param.value = value;
        param.events.push({ method: 'setValueAtTime', args: [value, time] });
        log.push(`${owner}:setValueAtTime`);
        return param;
      },
      setTargetAtTime: (target, time, timeConstant) => {
        param.events.push({ method: 'setTargetAtTime', args: [target, time, timeConstant] });
        log.push(`${owner}:setTargetAtTime`);
        return param;
      },
    };
    return param;
  };

  const context: FakeContext = {
    currentTime: options.currentTime ?? 0,
    sampleRate: CONTEXT_SAMPLE_RATE,
    destination: { kind: 'destination' },
    log,
    gains,
    sources,
    buffers,
    decodeRequests: 0,
    heldDecodes,

    createGain: () => {
      const gain: FakeGain = {
        gain: createParam(`gain${gains.length}`, 1),
        disconnects: 0,
        connect: () => gain,
        disconnect: () => {
          gain.disconnects += 1;
          log.push('gain:disconnect');
        },
      };
      gains.push(gain);
      return gain;
    },

    createBuffer: (numberOfChannels, length, sampleRate) => {
      const channels: Float32Array<ArrayBuffer>[] = [];
      for (let channel = 0; channel < numberOfChannels; channel += 1) {
        channels.push(new Float32Array(length));
      }
      const buffer: FakeBuffer = {
        numberOfChannels,
        length,
        sampleRate,
        duration: length / sampleRate,
        channels,
        getChannelData: (channel) => channels[channel],
        copyToChannel: (source, channel) => {
          channels[channel].set(source.subarray(0, length));
        },
      };
      buffers.push(buffer);
      return buffer;
    },

    createBufferSource: () => {
      const source: FakeSource = {
        buffer: null,
        startedAt: null,
        stoppedAt: null,
        disconnects: 0,
        onended: null,
        start: (when) => {
          source.startedAt = when ?? context.currentTime;
          log.push('source:start');
        },
        stop: (when) => {
          source.stoppedAt = when ?? context.currentTime;
          log.push('source:stop');
        },
        connect: () => source,
        disconnect: () => {
          source.disconnects += 1;
        },
        fireEnded: () => {
          source.onended?.();
        },
      };
      sources.push(source);
      return source;
    },

    decodeAudioData: () => {
      context.decodeRequests += 1;
      const decoded = context.createBuffer(1, TTS_SAMPLE_RATE, TTS_SAMPLE_RATE);
      if (options.holdDecodes === true) {
        return new Promise<FakeBuffer>((resolve) => {
          heldDecodes.push(resolve);
        });
      }
      return Promise.resolve(decoded);
    },
  };

  return context;
};

const asContext = (context: FakeContext): AudioContext => context as unknown as AudioContext;

const pcmPayload = (samples: number, value = 16384): ArrayBuffer => new Int16Array(samples).fill(value).buffer;

const pcmFrame = (turnId: number, sentenceIndex: number, samples: number): InboundAudioFrame => ({
  turnId,
  sentenceIndex,
  format: TTS_FORMAT_PCM16,
  sampleRate: TTS_SAMPLE_RATE,
  payload: pcmPayload(samples),
});

const mp3Frame = (turnId: number, sentenceIndex: number): InboundAudioFrame => ({
  turnId,
  sentenceIndex,
  format: TTS_FORMAT_MP3,
  sampleRate: TTS_SAMPLE_RATE,
  payload: pcmPayload(64, 7),
});

/** Let queued microtasks (the synchronous format-0 path awaits one) settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('pcm16ToFloat32', () => {
  test('decodes little-endian samples into Web Audio range', () => {
    const payload = new Uint8Array([0x00, 0x80, 0xff, 0x7f, 0x00, 0x00]).buffer;

    expect(Array.from(pcm16ToFloat32(payload))).toEqual([-1, 32767 / 32768, 0]);
  });

  test('ignores a trailing odd byte rather than reading past the payload', () => {
    const payload = new Uint8Array([0x00, 0x40, 0x01]).buffer;

    const samples = pcm16ToFloat32(payload);

    expect(samples).toHaveLength(1);
    expect(samples[0]).toBeCloseTo(16384 / 32768, 12);
  });
});

describe('computeChunkStartTime', () => {
  test('keeps a warm cursor and gives a cold queue its lead', () => {
    expect(computeChunkStartTime(10, 12.5, 0.02)).toBe(12.5);
    expect(computeChunkStartTime(10, 0, 0.02)).toBeCloseTo(10.02, 12);
    expect(computeChunkStartTime(10, 9.9, 0.02)).toBeCloseTo(10.02, 12);
  });
});

describe('findNearSilenceWindow', () => {
  test('trims near-silent edges up to the cap', () => {
    const samples = new Float32Array([0, 0, 0.4, 0.5, 0, 0]);

    expect(findNearSilenceWindow(samples, 10)).toEqual({ start: 2, end: 4 });
    expect(findNearSilenceWindow(samples, 1)).toEqual({ start: 1, end: 5 });
    expect(findNearSilenceWindow(samples, 0)).toEqual({ start: 0, end: 6 });
  });

  test('never trims a buffer down to nothing', () => {
    const silence = new Float32Array(8);

    expect(findNearSilenceWindow(silence, 100)).toEqual({ start: 0, end: 8 });
  });

  test('keeps a soft onset that sits above the threshold', () => {
    const samples = new Float32Array([0.02, 0.4, 0.4, 0.02]);

    expect(findNearSilenceWindow(samples, 10, 0.005)).toEqual({ start: 0, end: 4 });
  });
});

describe('createAudioQueue', () => {
  test('writes PCM16 straight into a buffer at the TTS rate, without decoding', async () => {
    const context = createContext({ currentTime: 10 });
    const queue = createAudioQueue(asContext(context));

    await queue.enqueue(pcmFrame(1, 0, 2400));

    expect(context.decodeRequests).toBe(0);
    expect(context.buffers).toHaveLength(1);
    expect(context.buffers[0].sampleRate).toBe(TTS_SAMPLE_RATE);
    expect(context.buffers[0].length).toBe(2400);
    expect(context.buffers[0].duration).toBeCloseTo(0.1, 12);
    // 16384 / 32768 written through copyToChannel.
    expect(context.buffers[0].getChannelData(0)[0]).toBeCloseTo(0.5, 12);
  });

  test('schedules sentences back to back on one cursor', async () => {
    const context = createContext({ currentTime: 10 });
    const queue = createAudioQueue(asContext(context));

    await queue.enqueue(pcmFrame(1, 0, 2400));
    await queue.enqueue(pcmFrame(1, 1, 4800));
    await queue.enqueue(pcmFrame(1, 2, 2400));

    const starts = context.sources.map((source) => source.startedAt ?? Number.NaN);
    expect(starts[0]).toBeGreaterThan(10);
    expect(starts[1]).toBeCloseTo((starts[0] ?? 0) + 0.1, 12);
    expect(starts[2]).toBeCloseTo((starts[1] ?? 0) + 0.2, 12);
    expect(queue.scheduledEndTime()).toBeCloseTo((starts[2] ?? 0) + 0.1, 12);
  });

  test('restarts from the clock when the queue ran dry', async () => {
    const context = createContext({ currentTime: 10 });
    const queue = createAudioQueue(asContext(context));

    await queue.enqueue(pcmFrame(1, 0, 2400));
    context.currentTime = 20;
    await queue.enqueue(pcmFrame(1, 1, 2400));

    expect(context.sources[1].startedAt).toBeGreaterThan(20);
  });

  test('flush ramps the master gain to silence before it stops any source', async () => {
    const context = createContext({ currentTime: 10 });
    const queue = createAudioQueue(asContext(context));
    await queue.enqueue(pcmFrame(1, 0, 24000));

    // Mid-sentence: an interrupt before the source started takes the silent path.
    context.currentTime = 10.5;
    queue.flush(1);

    const ramp = context.log.indexOf('gain0:setTargetAtTime');
    const stop = context.log.indexOf('source:stop');
    expect(ramp).toBeGreaterThanOrEqual(0);
    expect(stop).toBeGreaterThan(ramp);

    const rampEvent = context.gains[0].gain.events
      .filter((event) => event.method === 'setTargetAtTime')
      .pop();
    expect(rampEvent?.args).toEqual([0, 10.5, FLUSH_GAIN_TIME_CONSTANT_SECONDS]);
    // The source is cut after the ramp, not at the current sample.
    expect(context.sources[0].stoppedAt).toBeGreaterThan(10.5);
    expect(queue.scheduledEndTime()).toBe(0);
  });

  test('a flush that lands before a source started releases it without a ramp', async () => {
    const context = createContext({ currentTime: 10 });
    const queue = createAudioQueue(asContext(context));
    await queue.enqueue(pcmFrame(1, 0, 24000));

    queue.flush(1);
    const drained: number[] = [];
    queue.onDrained((turnId) => drained.push(turnId));
    context.sources[0].fireEnded();

    expect(context.sources[0].stoppedAt).toBe(10);
    expect(context.sources[0].disconnects).toBe(1);
    expect(drained).toEqual([]);
  });

  test('a late onended from a flushed turn cannot report a drain', async () => {
    const context = createContext({ currentTime: 10 });
    const queue = createAudioQueue(asContext(context));
    const drained: number[] = [];
    queue.onDrained((turnId) => drained.push(turnId));

    await queue.enqueue(pcmFrame(1, 0, 2400));
    queue.flush(1);
    context.sources[0].fireEnded();

    expect(drained).toEqual([]);

    await queue.enqueue(pcmFrame(2, 0, 2400));
    context.sources[1].fireEnded();

    expect(drained).toEqual([2]);
  });

  test('drops frames from an interrupted turn that were already in flight', async () => {
    const context = createContext({ currentTime: 10 });
    const queue = createAudioQueue(asContext(context));

    await queue.enqueue(pcmFrame(4, 0, 2400));
    queue.flush(4);
    await queue.enqueue(pcmFrame(4, 1, 2400));
    await settle();

    expect(context.sources).toHaveLength(1);
  });

  test('drops a frame whose turn is flushed while it is still being decoded', async () => {
    const context = createContext({ currentTime: 10, holdDecodes: true });
    const queue = createAudioQueue(asContext(context));

    const inFlight = queue.enqueue(mp3Frame(5, 0));
    await settle();
    expect(context.decodeRequests).toBe(1);

    queue.flush(5);
    context.heldDecodes[0]?.(context.createBuffer(1, TTS_SAMPLE_RATE, TTS_SAMPLE_RATE));
    await inFlight;

    expect(context.sources).toHaveLength(0);
  });

  test('decodes the MP3 fallback and reports a drain only after the last sentence', async () => {
    const context = createContext({ currentTime: 10 });
    const queue = createAudioQueue(asContext(context));
    const drained: number[] = [];
    queue.onDrained((turnId) => drained.push(turnId));

    await queue.enqueue(pcmFrame(3, 0, 2400));
    await queue.enqueue(mp3Frame(3, 1));

    expect(context.decodeRequests).toBe(1);
    expect(context.sources).toHaveLength(2);

    context.sources[0].fireEnded();
    expect(drained).toEqual([]);

    context.sources[1].fireEnded();
    expect(drained).toEqual([3]);
    expect(queue.scheduledEndTime()).toBe(0);
  });

  test('a newer turn cuts the superseded one instead of queueing behind it', async () => {
    const context = createContext({ currentTime: 10 });
    const queue = createAudioQueue(asContext(context));
    const drained: number[] = [];
    queue.onDrained((turnId) => drained.push(turnId));

    await queue.enqueue(pcmFrame(1, 0, 24000));
    context.currentTime = 10.5;
    await queue.enqueue(pcmFrame(6, 0, 2400));

    expect(context.sources[0].stoppedAt).toBeGreaterThan(10.5);
    expect(context.sources[1].startedAt).toBeGreaterThan(10.5);

    context.sources[0].fireEnded();
    expect(drained).toEqual([]);
  });

  test('ignores a flush for a turn that is already gone', async () => {
    const context = createContext({ currentTime: 10 });
    const queue = createAudioQueue(asContext(context));

    await queue.enqueue(pcmFrame(2, 0, 24000));
    queue.flush(1);

    expect(context.sources[0].stoppedAt).toBeNull();
    expect(queue.scheduledEndTime()).toBeGreaterThan(0);
  });

  test('ducking scales the master gain and is restored after an interrupt', async () => {
    const context = createContext({ currentTime: 10 });
    const queue = createAudioQueue(asContext(context));

    queue.setDucking(0.5);
    expect(context.gains[0].gain.events.at(-1)).toEqual({
      method: 'setTargetAtTime',
      args: [0.5, 10, 0.01],
    });

    await queue.enqueue(pcmFrame(1, 0, 2400));
    queue.flush(1);
    queue.setDucking(0.25);
    const eventsAfterFlush = context.gains[0].gain.events.length;

    await queue.enqueue(pcmFrame(2, 0, 2400));
    const restore = context.gains[0].gain.events
      .slice(eventsAfterFlush)
      .find((event) => event.method === 'setValueAtTime');

    // The master comes back at exactly the moment the new turn's audio starts,
    // never earlier: the cut sources are still ramping down until then.
    expect(restore?.args).toEqual([0.25, context.sources[1].startedAt]);
  });

  test('ignores a ducking value that is not a number', () => {
    const context = createContext({ currentTime: 10 });
    const queue = createAudioQueue(asContext(context));

    queue.setDucking(Number.NaN);
    queue.setDucking(Number.POSITIVE_INFINITY);

    expect(context.gains[0].gain.events).toEqual([]);
  });

  test('dispose cuts playback with the same ramp and releases the master gain', async () => {
    const context = createContext({ currentTime: 10 });
    const queue = createAudioQueue(asContext(context));
    await queue.enqueue(pcmFrame(1, 0, 24000));

    context.currentTime = 10.5;
    queue.dispose();

    expect(context.sources[0].stoppedAt).toBeGreaterThan(10.5);
    expect(context.gains[0].disconnects).toBe(0);

    context.sources[0].fireEnded();

    expect(context.gains[0].disconnects).toBe(1);
    expect(context.sources[0].disconnects).toBe(1);
  });

  test('dispose with nothing scheduled releases the master gain immediately', () => {
    const context = createContext({ currentTime: 10 });
    const queue = createAudioQueue(asContext(context));

    queue.dispose();

    expect(context.gains[0].disconnects).toBe(1);
    expect(queue.scheduledEndTime()).toBe(0);
  });

  test('an empty PCM payload schedules nothing', async () => {
    const context = createContext({ currentTime: 10 });
    const queue = createAudioQueue(asContext(context));

    await queue.enqueue(pcmFrame(1, 0, 0));

    expect(context.buffers).toHaveLength(0);
    expect(context.sources).toHaveLength(0);
  });

  test('enqueue never rejects when a chunk cannot be decoded', async () => {
    const context = createContext({ currentTime: 10 });
    const queue = createAudioQueue(asContext(context));
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message: string) => {
      warnings.push(message);
    };
    try {
      // A zero-length decode result is what a corrupt MP3 chunk amounts to here.
      context.decodeAudioData = () => {
        context.decodeRequests += 1;
        return Promise.reject(new Error('encoding error'));
      };
      await queue.enqueue(mp3Frame(1, 0));
    } finally {
      console.warn = originalWarn;
    }

    expect(context.sources).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('dropping undecodable tts chunk');
  });
});
