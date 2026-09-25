import { describe, expect, it } from 'bun:test';

import { pcm16ToWav } from '../dictation/audio.js';
import {
  createTtsSynthesizer,
  parseWavHeader,
  trimPcm16NearSilence,
  TTS_RESPONSE_FORMAT_MP3,
  TTS_RESPONSE_FORMAT_WAV,
} from './tts.js';

const LOCAL_BASE_URL = 'http://127.0.0.1:9999/v1';

const tone = (samples, amplitude = 8000) => {
  const arr = new Int16Array(samples);
  for (let i = 0; i < samples; i += 1) {
    arr[i] = i % 2 === 0 ? amplitude : -amplitude;
  }
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
};

/** Build a RIFF WAVE whose `fmt ` chunk is rewritten, for rejection tests. */
const mutatedWav = (pcm, sampleRate, mutate) => {
  const wav = pcm16ToWav(pcm, sampleRate);
  mutate(wav);
  return wav;
};

/** Insert a LIST chunk between `fmt ` and `data`, as real recorders do. */
const wavWithExtraChunk = (pcm, sampleRate) => {
  const listPayload = Buffer.from('INFOISFTtest', 'ascii');
  const listChunk = Buffer.alloc(8 + listPayload.length);
  listChunk.write('LIST', 0);
  listChunk.writeUInt32LE(listPayload.length, 4);
  listPayload.copy(listChunk, 8);

  const wav = pcm16ToWav(pcm, sampleRate);
  const head = wav.subarray(0, 36);
  const data = wav.subarray(36);
  const out = Buffer.concat([head, listChunk, data]);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
};

const fakeResponse = ({ status = 200, chunks = [], text = '' } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? 'OK' : 'Internal Server Error',
  body: {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  },
  text: async () => text,
});

const collect = async (iterable) => {
  const out = [];
  for await (const piece of iterable) {
    out.push(piece);
  }
  return out;
};

describe('parseWavHeader', () => {
  it('reads the canonical 44-byte PCM16 mono header', () => {
    const parsed = parseWavHeader(pcm16ToWav(tone(100), 24000));
    expect(parsed).toEqual({ sampleRate: 24000, dataOffset: 44 });
  });

  it('walks past an extra chunk to find data', () => {
    const wav = wavWithExtraChunk(tone(100), 24000);
    const parsed = parseWavHeader(wav);
    expect(parsed.sampleRate).toBe(24000);
    expect(parsed.dataOffset).toBeGreaterThan(44);
    expect(wav.toString('ascii', parsed.dataOffset - 8, parsed.dataOffset - 4)).toBe('data');
    expect(wav.subarray(parsed.dataOffset).length).toBe(200);
  });

  it('rejects stereo, 8-bit, float and non-RIFF input', () => {
    const pcm = tone(100);
    expect(parseWavHeader(mutatedWav(pcm, 24000, (w) => w.writeUInt16LE(2, 22))).error).toMatch(/mono/);
    expect(parseWavHeader(mutatedWav(pcm, 24000, (w) => w.writeUInt16LE(8, 34))).error).toMatch(/16-bit/);
    expect(parseWavHeader(mutatedWav(pcm, 24000, (w) => w.writeUInt16LE(3, 20))).error).toMatch(/audio format 3/);
    expect(parseWavHeader(mutatedWav(pcm, 24000, (w) => w.write('RIXX', 0))).error).toMatch(/RIFF WAVE/);
  });

  it('reports a truncated buffer rather than misreading it', () => {
    expect(parseWavHeader(pcm16ToWav(tone(10), 24000).subarray(0, 20)).error).toBe('WAV header truncated');
  });
});

describe('trimPcm16NearSilence', () => {
  it('trims near-silence from both ends and keeps the middle', () => {
    const padded = Buffer.concat([tone(40, 10), tone(60, 9000), tone(40, 10)]);
    const trimmed = trimPcm16NearSilence(padded);
    expect(trimmed.length).toBe(120);
  });

  it('is a no-op when there is nothing to trim', () => {
    const pcm = tone(60, 9000);
    expect(trimPcm16NearSilence(pcm)).toBe(pcm);
  });

  it('honours a custom threshold and trim bound', () => {
    const padded = Buffer.concat([tone(40, 500), tone(60, 9000), tone(40, 500)]);
    expect(trimPcm16NearSilence(padded, { threshold: 160 }).length).toBe(padded.length);
    // 10 samples trimmed off each end = 40 bytes gone.
    expect(trimPcm16NearSilence(padded, { threshold: 1000, maxTrimSamples: 10 }).length).toBe(padded.length - 40);
    expect(trimPcm16NearSilence(padded, { threshold: 1000 }).length).toBe(120);
  });
});

describe('createTtsSynthesizer configuration', () => {
  it('requires a base URL and rejects a non-http scheme', () => {
    expect(() => createTtsSynthesizer({ baseUrl: '', model: 'kokoro', voice: 'zf_001' })).toThrow(/base URL is required/);
    expect(() => createTtsSynthesizer({ baseUrl: 'ftp://127.0.0.1/v1', model: 'kokoro', voice: 'zf_001' })).toThrow(/http or https/);
    expect(() => createTtsSynthesizer({ baseUrl: 'http://user:pw@127.0.0.1/v1', model: 'kokoro', voice: 'zf_001' })).toThrow(/credentials/);
  });

  it('targets {baseUrl}/audio/speech with the SSRF guard applied', () => {
    const tts = createTtsSynthesizer({ baseUrl: 'http://127.0.0.1:9999/v1/', model: 'kokoro', voice: 'zf_001' });
    expect(tts.speechUrl).toBe('http://127.0.0.1:9999/v1/audio/speech');
  });
});

describe('createTtsSynthesizer.synthesize', () => {
  const build = ({ status = 200, chunks = [], text = '', format = TTS_RESPONSE_FORMAT_WAV } = {}) => {
    const calls = [];
    const tts = createTtsSynthesizer({
      baseUrl: LOCAL_BASE_URL,
      apiKey: 'test-key',
      model: 'kokoro',
      voice: 'zf_001',
      responseFormat: format,
      fetchImpl: async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body), signal: init.signal });
        return fakeResponse({ status, chunks, text });
      },
    });
    return { tts, calls };
  };

  it('strips the WAV header and yields raw PCM with the parsed sample rate', async () => {
    const pcm = tone(500);
    const { tts, calls } = build({ chunks: [pcm16ToWav(pcm, 24000)] });

    const pieces = await collect(tts.synthesize('你好'));

    expect(pieces).toHaveLength(1);
    expect(pieces[0].sampleRate).toBe(24000);
    expect(Buffer.compare(pieces[0].pcm, pcm)).toBe(0);
    expect(calls[0].url).toBe(`${LOCAL_BASE_URL}/audio/speech`);
    expect(calls[0].body).toEqual({ model: 'kokoro', voice: 'zf_001', input: '你好', speed: 1, response_format: 'wav' });
  });

  it('reassembles a header split across body chunks', async () => {
    const wav = pcm16ToWav(tone(500), 24000);
    const { tts } = build({ chunks: [wav.subarray(0, 20), wav.subarray(20)] });

    const pieces = await collect(tts.synthesize('你好'));

    expect(pieces).toHaveLength(1);
    expect(pieces[0].pcm.length).toBe(wav.length - 44);
  });

  it('yields one frame per body chunk so a long sentence streams', async () => {
    // 1500 samples = 3000 bytes of PCM + a 44-byte header = 3044, so slicing at
    // 1044 / 2044 leaves three non-empty body chunks of 1000 bytes each.
    const wav = pcm16ToWav(tone(1500), 24000);
    const { tts } = build({ chunks: [wav.subarray(0, 1044), wav.subarray(1044, 2044), wav.subarray(2044)] });

    const pieces = await collect(tts.synthesize('一句很长的话'));

    expect(pieces).toHaveLength(3);
    expect(pieces.map((p) => p.pcm.length)).toEqual([1000, 1000, 1000]);
    expect(Buffer.concat(pieces.map((p) => p.pcm)).length).toBe(wav.length - 44);
  });

  it('degrades to MP3 when the backend refuses WAV', async () => {
    const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x01, 0x02]);
    let attempt = 0;
    const tts = createTtsSynthesizer({
      baseUrl: LOCAL_BASE_URL,
      model: 'kokoro',
      voice: 'zf_001',
      fetchImpl: async (_url, init) => {
        attempt += 1;
        const body = JSON.parse(init.body);
        if (body.response_format === 'wav') {
          return fakeResponse({ status: 500, text: 'unsupported response_format' });
        }
        return fakeResponse({ status: 200, chunks: [mp3] });
      },
    });

    const pieces = await collect(tts.synthesize('你好'));

    expect(attempt).toBe(2);
    expect(pieces).toEqual([{ mp3 }]);
  });

  it('degrades to MP3 when WAV returns audio that is not PCM16 mono', async () => {
    const stereo = mutatedWav(tone(200), 24000, (w) => w.writeUInt16LE(2, 22));
    const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
    const tts = createTtsSynthesizer({
      baseUrl: LOCAL_BASE_URL,
      model: 'kokoro',
      voice: 'zf_001',
      fetchImpl: async (_url, init) =>
        JSON.parse(init.body).response_format === 'wav'
          ? fakeResponse({ status: 200, chunks: [stereo] })
          : fakeResponse({ status: 200, chunks: [mp3] }),
    });

    const pieces = await collect(tts.synthesize('你好'));

    expect(pieces).toEqual([{ mp3 }]);
  });

  it('throws when every format fails', async () => {
    const { tts } = build({ status: 500, text: 'boom' });
    await expect(collect(tts.synthesize('你好'))).rejects.toThrow(/boom/);
  });

  it('passes the abort signal to fetch and stops mid-stream', async () => {
    const controller = new AbortController();
    const wav = pcm16ToWav(tone(900), 24000);
    const { tts, calls } = build({ chunks: [wav.subarray(0, 1044), wav.subarray(1044)] });

    const pieces = [];
    for await (const piece of tts.synthesize('你好', { signal: controller.signal })) {
      pieces.push(piece);
      controller.abort();
    }

    // fetch receives the internal signal that merges the caller's abort with
    // the request timeout, so it is an AbortSignal but not the caller's own.
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
    expect(calls[0].signal.aborted).toBe(true);
    expect(pieces).toHaveLength(1);
  });

  it('does not call the backend for empty text', async () => {
    const { tts, calls } = build({ chunks: [] });
    expect(await collect(tts.synthesize('   '))).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('requests MP3 directly when configured for the fallback', async () => {
    const { tts, calls } = build({ format: TTS_RESPONSE_FORMAT_MP3, chunks: [Buffer.from([0xff, 0xfb])] });
    const pieces = await collect(tts.synthesize('你好'));

    expect(calls).toHaveLength(1);
    expect(calls[0].body.response_format).toBe('mp3');
    expect(pieces).toEqual([{ mp3: Buffer.from([0xff, 0xfb]) }]);
  });
});
