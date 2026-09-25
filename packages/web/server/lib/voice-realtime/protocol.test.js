import { afterAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isAllowedRelayWebSocketPath } from '../relay/tunnel-host.js';
import {
  decodeClientAudio,
  decodeControl,
  decodeServerAudio,
  encodeClientAudio,
  encodeControl,
  encodeServerAudio,
  frameTagOf,
  VOICE_REALTIME_AUDIO_FORMAT_MP3,
  VOICE_REALTIME_AUDIO_FORMAT_PCM16,
  VOICE_REALTIME_FRAME_CLIENT_AUDIO,
  VOICE_REALTIME_FRAME_CONTROL,
  VOICE_REALTIME_FRAME_SERVER_AUDIO,
  VOICE_REALTIME_WS_HEARTBEAT_INTERVAL_MS,
  VOICE_REALTIME_WS_MAX_PAYLOAD_BYTES,
  VOICE_REALTIME_WS_PATH,
} from './protocol.js';

const pcm16 = (samples) => {
  const arr = Int16Array.from(samples);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
};

describe('voice realtime protocol constants', () => {
  it('exposes the endpoint path and limits', () => {
    expect(VOICE_REALTIME_WS_PATH).toBe('/api/voice/realtime');
    expect(VOICE_REALTIME_WS_MAX_PAYLOAD_BYTES).toBe(1024 * 1024);
    expect(VOICE_REALTIME_WS_HEARTBEAT_INTERVAL_MS).toBe(30000);
  });

  it('assigns the three frame tags from the normative layout', () => {
    expect(VOICE_REALTIME_FRAME_CONTROL).toBe(0x01);
    expect(VOICE_REALTIME_FRAME_CLIENT_AUDIO).toBe(0x02);
    expect(VOICE_REALTIME_FRAME_SERVER_AUDIO).toBe(0x03);
    expect(VOICE_REALTIME_AUDIO_FORMAT_PCM16).toBe(0);
    expect(VOICE_REALTIME_AUDIO_FORMAT_MP3).toBe(1);
  });
});

describe('voice realtime control frames (0x01)', () => {
  it('round-trips a JSON control object', () => {
    const message = { type: 'start', sessionId: 'vr_1', config: { brain: 'assistant' } };
    const frame = encodeControl(message);

    expect(frame[0]).toBe(VOICE_REALTIME_FRAME_CONTROL);
    expect(decodeControl(frame)).toEqual(message);
  });

  it('encodes non-ASCII control payloads as UTF-8', () => {
    const frame = encodeControl({ type: 'user_text', text: '你好，世界' });
    expect(decodeControl(frame).text).toBe('你好，世界');
  });

  it('rejects a frame carrying the wrong tag', () => {
    const audio = encodeClientAudio({ seq: 1, sampleRate: 16000, pcm: pcm16([1, 2]) });
    expect(decodeControl(audio)).toBeNull();
  });

  it('rejects malformed JSON instead of throwing', () => {
    const broken = Buffer.concat([Buffer.from([VOICE_REALTIME_FRAME_CONTROL]), Buffer.from('{oops')]);
    expect(decodeControl(broken)).toBeNull();
  });

  it('throws on a non-object control message', () => {
    expect(() => encodeControl(null)).toThrow(TypeError);
  });
});

describe('voice realtime client audio frames (0x02)', () => {
  it('lays out tag | seq u32 BE | sampleRate u32 BE | PCM16LE', () => {
    const frame = encodeClientAudio({ seq: 0x01020304, sampleRate: 16000, pcm: pcm16([1000, -1000]) });

    expect(frame.length).toBe(9 + 4);
    expect(frame[0]).toBe(VOICE_REALTIME_FRAME_CLIENT_AUDIO);
    expect(frame.readUInt32BE(1)).toBe(0x01020304);
    expect(frame.readUInt32BE(5)).toBe(16000);
    expect(frame.readInt16LE(9)).toBe(1000);
    expect(frame.readInt16LE(11)).toBe(-1000);
  });

  it('round-trips a 100 ms frame', () => {
    const samples = Array.from({ length: 1600 }, (_, i) => (i % 2 === 0 ? 4000 : -4000));
    const decoded = decodeClientAudio(encodeClientAudio({ seq: 42, sampleRate: 16000, pcm: pcm16(samples) }));

    expect(decoded.seq).toBe(42);
    expect(decoded.sampleRate).toBe(16000);
    expect(decoded.pcm.length).toBe(3200);
    expect(Array.from(new Int16Array(decoded.pcm.buffer, decoded.pcm.byteOffset, 1600))).toEqual(samples);
  });

  it('rejects a truncated header and an odd-length payload', () => {
    expect(decodeClientAudio(Buffer.from([VOICE_REALTIME_FRAME_CLIENT_AUDIO, 0, 0, 0]))).toBeNull();
    const odd = Buffer.concat([
      Buffer.from([VOICE_REALTIME_FRAME_CLIENT_AUDIO, 0, 0, 0, 0, 0, 0, 0x3e, 0x80]),
      Buffer.from([1, 2, 3]),
    ]);
    expect(decodeClientAudio(odd)).toBeNull();
  });

  it('rejects a seq that does not fit u32', () => {
    expect(() => encodeClientAudio({ seq: -1, sampleRate: 16000, pcm: pcm16([1]) })).toThrow(TypeError);
    expect(() => encodeClientAudio({ seq: 2 ** 32, sampleRate: 16000, pcm: pcm16([1]) })).toThrow(TypeError);
  });
});

describe('voice realtime server audio frames (0x03)', () => {
  it('lays out tag | turnId u32 BE | sentenceIndex u8 | format u8 | sampleRate u32 BE | payload', () => {
    const frame = encodeServerAudio({
      turnId: 7,
      sentenceIndex: 3,
      format: VOICE_REALTIME_AUDIO_FORMAT_PCM16,
      sampleRate: 24000,
      payload: pcm16([32767, -32768]),
    });

    expect(frame.length).toBe(11 + 4);
    expect(frame[0]).toBe(VOICE_REALTIME_FRAME_SERVER_AUDIO);
    expect(frame.readUInt32BE(1)).toBe(7);
    expect(frame[5]).toBe(3);
    expect(frame[6]).toBe(VOICE_REALTIME_AUDIO_FORMAT_PCM16);
    expect(frame.readUInt32BE(7)).toBe(24000);
    expect(frame.readInt16LE(11)).toBe(32767);
    expect(frame.readInt16LE(13)).toBe(-32768);
  });

  it('round-trips the MP3 fallback format', () => {
    const decoded = decodeServerAudio(
      encodeServerAudio({
        turnId: 1,
        sentenceIndex: 0,
        format: VOICE_REALTIME_AUDIO_FORMAT_MP3,
        sampleRate: 0,
        payload: Buffer.from([0xff, 0xfb, 0x90, 0x00]),
      }),
    );

    expect(decoded.format).toBe(VOICE_REALTIME_AUDIO_FORMAT_MP3);
    expect(decoded.sampleRate).toBe(0);
    expect(Array.from(decoded.payload)).toEqual([0xff, 0xfb, 0x90, 0x00]);
  });

  it('carries the turnId the client and the send site both gate on', () => {
    const decoded = decodeServerAudio(
      encodeServerAudio({
        turnId: 0xffffffff,
        sentenceIndex: 255,
        format: 0,
        sampleRate: 24000,
        payload: Buffer.alloc(0),
      }),
    );
    expect(decoded.turnId).toBe(0xffffffff);
    expect(decoded.sentenceIndex).toBe(255);
  });

  it('rejects out-of-range header fields', () => {
    expect(() =>
      encodeServerAudio({ turnId: 1, sentenceIndex: 256, format: 0, sampleRate: 24000, payload: Buffer.alloc(0) }),
    ).toThrow(TypeError);
    expect(() =>
      encodeServerAudio({ turnId: 1, sentenceIndex: 0, format: 2, sampleRate: 24000, payload: Buffer.alloc(0) }),
    ).toThrow(TypeError);
  });
});

describe('frameTagOf', () => {
  it('classifies the three tags and rejects anything else', () => {
    expect(frameTagOf(Buffer.from([0x01, 0x00]))).toBe(VOICE_REALTIME_FRAME_CONTROL);
    expect(frameTagOf(Buffer.from([0x02]))).toBe(VOICE_REALTIME_FRAME_CLIENT_AUDIO);
    expect(frameTagOf(Buffer.from([0x03]))).toBe(VOICE_REALTIME_FRAME_SERVER_AUDIO);
    expect(frameTagOf(Buffer.from([0x04]))).toBeNull();
    expect(frameTagOf(Buffer.alloc(0))).toBeNull();
    expect(frameTagOf(null)).toBeNull();
  });
});

// The path must be allowlisted in exactly two places: the UI auth URL-token
// gate and the relay tunnel host. `realtime-proxy.js` is deliberately absent —
// it does not list `/api/dictation/ws` either, so adding ours there would be
// inconsistent with the existing streaming-audio endpoint.
describe('voice realtime path allowlists', () => {
  it('is allowed by the relay tunnel WebSocket allowlist', () => {
    expect(isAllowedRelayWebSocketPath(VOICE_REALTIME_WS_PATH)).toBe(true);
    expect(isAllowedRelayWebSocketPath('/api/dictation/ws')).toBe(true);
  });

  describe('ui auth url-token gate', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-voice-realtime-auth-'));
    process.env.OPENCHAMBER_DATA_DIR = dataDir;
    afterAll(() => {
      fs.rmSync(dataDir, { recursive: true, force: true });
    });

    const createResponse = () => {
      let body = null;
      return {
        status() { return this; },
        json(payload) { body = payload; return this; },
        setHeader() { return this; },
        getHeader() { return undefined; },
        get body() { return body; },
      };
    };

    it('accepts a URL auth token on the WebSocket upgrade', async () => {
      const { createUiAuth } = await import('../ui-auth/ui-auth.js');
      const auth = createUiAuth({
        password: 'secret',
        clientAuthController: {
          authenticateBearerToken: async (token) =>
            token === 'client-token' ? { ok: true, clientId: 'device-1' } : null,
        },
      });

      const mintRes = createResponse();
      await auth.handleUrlAuthToken(
        { method: 'POST', path: '/auth/url-token', headers: { authorization: 'Bearer client-token', accept: 'application/json' } },
        mintRes,
      );
      const urlToken = mintRes.body.token;
      expect(urlToken.startsWith('oc_url_')).toBe(true);

      const upgradeReq = {
        method: 'GET',
        path: VOICE_REALTIME_WS_PATH,
        url: `${VOICE_REALTIME_WS_PATH}?oc_url_token=${encodeURIComponent(urlToken)}`,
        headers: { upgrade: 'websocket' },
      };
      expect(await auth.ensureSessionToken(upgradeReq, null)).toBe('client:device-1');
    });
  });
});
