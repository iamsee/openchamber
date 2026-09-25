import { describe, expect, test } from 'bun:test';

import {
  decodeServerFrame,
  encodeControlFrame,
  encodeMicAudioFrame,
  MIC_AUDIO_FRAME_SAMPLES,
  MIC_AUDIO_HEADER_BYTES,
  MIC_AUDIO_SAMPLE_RATE,
  parseServerControl,
  TTS_AUDIO_HEADER_BYTES,
  TTS_FORMAT_MP3,
  TTS_FORMAT_PCM16,
  VoiceProtocolError,
  VOICE_FRAME_CONTROL,
  VOICE_FRAME_MIC_AUDIO,
  VOICE_FRAME_TTS_AUDIO,
  VOICE_REALTIME_WS_PATH,
  type ClientControl,
  type InboundAudioFrame,
  type ServerControl,
} from './protocol';

const encoder = new TextEncoder();

const buildTtsFrame = (options: {
  turnId: number;
  sentenceIndex: number;
  format: number;
  sampleRate: number;
  payload: number[];
}): ArrayBuffer => {
  const frame = new Uint8Array(TTS_AUDIO_HEADER_BYTES + options.payload.length);
  const view = new DataView(frame.buffer);
  view.setUint8(0, VOICE_FRAME_TTS_AUDIO);
  view.setUint32(1, options.turnId, false);
  view.setUint8(5, options.sentenceIndex);
  view.setUint8(6, options.format);
  view.setUint32(7, options.sampleRate, false);
  frame.set(options.payload, TTS_AUDIO_HEADER_BYTES);
  return frame.buffer;
};

const buildControlFrame = (message: object): ArrayBuffer => {
  const json = encoder.encode(JSON.stringify(message));
  const frame = new Uint8Array(1 + json.byteLength);
  frame[0] = VOICE_FRAME_CONTROL;
  frame.set(json, 1);
  return frame.buffer;
};

const pcmFrame = (samples: number): Int16Array => {
  const frame = new Int16Array(samples);
  for (let index = 0; index < samples; index += 1) {
    frame[index] = index % 2 === 0 ? 1000 : -1000;
  }
  return frame;
};

const decodeAudio = (data: ArrayBuffer): InboundAudioFrame => {
  const decoded = decodeServerFrame(data);
  if (decoded.kind !== 'audio') {
    throw new Error(`expected an audio frame, got ${decoded.kind}`);
  }
  return decoded.frame;
};

const decodeControl = (data: ArrayBuffer): ServerControl => {
  const decoded = decodeServerFrame(data);
  if (decoded.kind !== 'control') {
    throw new Error(`expected a control frame, got ${decoded.kind}`);
  }
  return decoded.message;
};

describe('voice realtime protocol', () => {
  test('names the path the server registers', () => {
    expect(VOICE_REALTIME_WS_PATH).toBe('/api/voice/realtime');
  });

  test('control frames are tag 0x01 followed by UTF-8 JSON', () => {
    const message: ClientControl = { type: 'barge_in' };
    const frame = new Uint8Array(encodeControlFrame(message));

    expect(frame[0]).toBe(VOICE_FRAME_CONTROL);
    expect(new TextDecoder().decode(frame.subarray(1))).toBe('{"type":"barge_in"}');
  });

  test('mic audio frames carry tag, seq and sample rate big-endian, then raw PCM', () => {
    const pcm = pcmFrame(MIC_AUDIO_FRAME_SAMPLES);
    const frame = new Uint8Array(encodeMicAudioFrame(pcm, 0x01020304));
    const view = new DataView(frame.buffer);

    expect(frame.byteLength).toBe(MIC_AUDIO_HEADER_BYTES + MIC_AUDIO_FRAME_SAMPLES * 2);
    expect(view.getUint8(0)).toBe(VOICE_FRAME_MIC_AUDIO);
    expect(view.getUint32(1, false)).toBe(0x01020304);
    expect(view.getUint32(5, false)).toBe(MIC_AUDIO_SAMPLE_RATE);
    expect(frame.subarray(MIC_AUDIO_HEADER_BYTES)).toEqual(
      new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength),
    );
  });

  test('mic audio frames reject a payload that is not exactly one 100 ms frame', () => {
    expect(() => encodeMicAudioFrame(pcmFrame(MIC_AUDIO_FRAME_SAMPLES - 1), 0)).toThrow(VoiceProtocolError);
    expect(() => encodeMicAudioFrame(pcmFrame(MIC_AUDIO_FRAME_SAMPLES + 1), 0)).toThrow(VoiceProtocolError);
    expect(() => encodeMicAudioFrame(pcmFrame(MIC_AUDIO_FRAME_SAMPLES), -1)).toThrow(VoiceProtocolError);
    expect(() => encodeMicAudioFrame(pcmFrame(MIC_AUDIO_FRAME_SAMPLES), 1.5)).toThrow(VoiceProtocolError);
  });

  test('mic audio encoding copies the samples and leaves the caller buffer usable', () => {
    const pcm = pcmFrame(MIC_AUDIO_FRAME_SAMPLES);
    const frame = new Uint8Array(encodeMicAudioFrame(pcm, 1));
    pcm[0] = 0;

    expect(new DataView(frame.buffer).getInt16(MIC_AUDIO_HEADER_BYTES, true)).toBe(1000);
  });

  test('tts audio frames decode every header field and copy the payload out', () => {
    const frame = decodeAudio(
      buildTtsFrame({
        turnId: 42,
        sentenceIndex: 3,
        format: TTS_FORMAT_PCM16,
        sampleRate: 24000,
        payload: [1, 2, 3, 4],
      }),
    );

    expect(frame.turnId).toBe(42);
    expect(frame.sentenceIndex).toBe(3);
    expect(frame.format).toBe(TTS_FORMAT_PCM16);
    expect(frame.sampleRate).toBe(24000);
    expect(new Uint8Array(frame.payload)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(frame.payload.byteLength).toBe(4);
  });

  test('mp3 payloads may be any length, PCM payloads may not be odd', () => {
    const mp3 = decodeAudio(
      buildTtsFrame({ turnId: 1, sentenceIndex: 0, format: TTS_FORMAT_MP3, sampleRate: 24000, payload: [1, 2, 3] }),
    );
    expect(mp3.format).toBe(TTS_FORMAT_MP3);
    expect(mp3.payload.byteLength).toBe(3);

    expect(() =>
      decodeServerFrame(
        buildTtsFrame({ turnId: 1, sentenceIndex: 0, format: TTS_FORMAT_PCM16, sampleRate: 24000, payload: [1, 2, 3] }),
      ),
    ).toThrow('odd byte length');
  });

  test('tts frames reject truncation, unknown formats and a zero sample rate', () => {
    expect(() => decodeServerFrame(new Uint8Array([VOICE_FRAME_TTS_AUDIO, 0, 0]).buffer)).toThrow(
      'shorter than its 11-byte header',
    );
    expect(() =>
      decodeServerFrame(
        buildTtsFrame({ turnId: 1, sentenceIndex: 0, format: 7, sampleRate: 24000, payload: [] }),
      ),
    ).toThrow('unknown format 7');
    expect(() =>
      decodeServerFrame(
        buildTtsFrame({ turnId: 1, sentenceIndex: 0, format: TTS_FORMAT_PCM16, sampleRate: 0, payload: [] }),
      ),
    ).toThrow('sampleRate 0');
  });

  test('inbound mic frames and unknown tags are protocol errors, not guesses', () => {
    const micEcho = new Uint8Array(MIC_AUDIO_HEADER_BYTES + 2);
    micEcho[0] = VOICE_FRAME_MIC_AUDIO;
    expect(() => decodeServerFrame(micEcho.buffer)).toThrow('unknown voice frame tag 0x2');
    expect(() => decodeServerFrame(new Uint8Array([0x09]).buffer)).toThrow('unknown voice frame tag 0x9');
    expect(() => decodeServerFrame(new ArrayBuffer(0))).toThrow('voice frame is empty');
  });

  test('control frames round trip through decodeServerFrame', () => {
    expect(decodeControl(buildControlFrame({ type: 'flush_audio', turnId: 9 }))).toEqual({
      type: 'flush_audio',
      turnId: 9,
    });
  });

  test('parses every server control message', () => {
    const cases: Array<[object, ServerControl]> = [
      [
        { type: 'ready', sessionId: 'vr_1', defaults: { frameMs: 100 } },
        { type: 'ready', sessionId: 'vr_1', defaults: { frameMs: 100 } },
      ],
      [{ type: 'ready', sessionId: 'vr_1' }, { type: 'ready', sessionId: 'vr_1', defaults: {} }],
      [{ type: 'state', state: 'SPEAKING', turnId: 2 }, { type: 'state', state: 'SPEAKING', turnId: 2 }],
      [{ type: 'vad', voiced: true }, { type: 'vad', voiced: true }],
      [
        { type: 'user_text', turnId: 2, text: 'hi', final: true, speculative: false },
        { type: 'user_text', turnId: 2, text: 'hi', final: true, speculative: false },
      ],
      [
        { type: 'assistant_text', turnId: 2, delta: 'he', text: 'he', final: false },
        { type: 'assistant_text', turnId: 2, delta: 'he', text: 'he', final: false },
      ],
      [
        { type: 'assistant_text', turnId: 2, text: 'hello', final: true },
        { type: 'assistant_text', turnId: 2, text: 'hello', final: true },
      ],
      [{ type: 'audio_end', turnId: 2 }, { type: 'audio_end', turnId: 2 }],
      [
        { type: 'calibration', echoPeak: 0.031, fullDuplexSafe: true },
        { type: 'calibration', echoPeak: 0.031, fullDuplexSafe: true },
      ],
      [
        { type: 'error', error: 'stt failed', retryable: true, reasonCode: 'stt' },
        { type: 'error', error: 'stt failed', retryable: true, reasonCode: 'stt' },
      ],
      [{ type: 'pong' }, { type: 'pong' }],
    ];

    for (const [json, expected] of cases) {
      expect(parseServerControl(JSON.stringify(json))).toEqual(expected);
    }
  });

  test('control parsing rejects malformed payloads instead of casting them', () => {
    expect(() => parseServerControl('not json')).toThrow('not valid JSON');
    expect(() => parseServerControl('[1,2]')).toThrow('not a JSON object');
    expect(() => parseServerControl('{}')).toThrow('missing a string "type"');
    expect(() => parseServerControl('{"type":"teleport"}')).toThrow('unknown control frame type');
    expect(() => parseServerControl('{"type":"state","state":"SPEAKING","turnId":"2"}')).toThrow(
      '"turnId" must be a finite number',
    );
    expect(() => parseServerControl('{"type":"state","state":"TALKING","turnId":1}')).toThrow(
      'unknown session state "TALKING"',
    );
    expect(() => parseServerControl('{"type":"flush_audio","turnId":1.5}')).toThrow(
      '"turnId" must be a non-negative integer',
    );
    expect(() => parseServerControl('{"type":"vad","voiced":"yes"}')).toThrow('"voiced" must be a boolean');
    expect(() => parseServerControl('{"type":"user_text","turnId":1,"final":true,"speculative":false}')).toThrow(
      '"text" must be a string',
    );
    expect(() => parseServerControl('{"type":"ready","sessionId":"vr_1","defaults":7}')).toThrow(
      '"defaults" must be an object',
    );
    expect(() => parseServerControl('{"type":"calibration","echoPeak":0.1,"fullDuplexSafe":"yes"}')).toThrow(
      '"fullDuplexSafe" must be a boolean',
    );
    expect(() => parseServerControl('{"type":"calibration","echoPeak":"loud","fullDuplexSafe":true}')).toThrow(
      '"echoPeak" must be a finite number',
    );
  });

  test('a malformed frame throws VoiceProtocolError so callers can drop just that frame', () => {
    expect(() => decodeServerFrame(new Uint8Array([0x09]).buffer)).toThrow(VoiceProtocolError);
    expect(() => decodeServerFrame(buildControlFrame({ type: 'nope' }))).toThrow(VoiceProtocolError);
  });
});
