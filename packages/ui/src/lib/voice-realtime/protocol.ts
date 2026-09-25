/**
 * Wire codec for the realtime voice socket (/api/voice/realtime).
 *
 * Every message is binary and byte 0 is the frame tag (plan §5.1):
 *
 *   0x01 control    UTF-8 JSON body, both directions
 *   0x02 mic audio  client -> server: seq u32 BE | sampleRate u32 BE | PCM16LE
 *   0x03 tts audio  server -> client: turnId u32 BE | sentenceIndex u8 |
 *                   format u8 | sampleRate u32 BE | payload
 *
 * There is no ack and no reorder machinery: WebSocket over TCP is already
 * ordered and reliable, so `seq` is a debug counter only.
 *
 * This module is pure — no DOM, no socket, no AudioContext — so the codec is
 * unit-testable and the client module stays transport wiring. The server mirror
 * is `packages/web/server/lib/voice-realtime/protocol.js`; the two must stay
 * byte-compatible, so a layout change here is a change there.
 */

export const VOICE_REALTIME_WS_PATH = '/api/voice/realtime';

export const VOICE_FRAME_CONTROL = 0x01;
export const VOICE_FRAME_MIC_AUDIO = 0x02;
export const VOICE_FRAME_TTS_AUDIO = 0x03;

/** tag | seq u32 | sampleRate u32 */
export const MIC_AUDIO_HEADER_BYTES = 9;
/** tag | turnId u32 | sentenceIndex u8 | format u8 | sampleRate u32 */
export const TTS_AUDIO_HEADER_BYTES = 11;

export const MIC_AUDIO_SAMPLE_RATE = 16000;
/** 100 ms of 16 kHz mono — the frame size the server VAD counts on. */
export const MIC_AUDIO_FRAME_SAMPLES = 1600;

export const TTS_FORMAT_PCM16 = 0;
/** Degradation path only, for a gateway that refuses WAV (plan §5.2). */
export const TTS_FORMAT_MP3 = 1;

export type TtsAudioFormat = typeof TTS_FORMAT_PCM16 | typeof TTS_FORMAT_MP3;

export const VOICE_SESSION_STATES = ['IDLE', 'LISTENING', 'THINKING', 'SPEAKING'] as const;

export type VoiceSessionState = (typeof VOICE_SESSION_STATES)[number];

export interface RealtimeVoiceConfig {
  brain: 'assistant' | 'session';
  sttOnly?: boolean;
  provider: { url: string; model: string; apiKey?: string };
  stt: { url: string; model: string; apiKey?: string; language?: string };
  tts: { url: string; model: string; voice: string; apiKey?: string };
}

/** One synthesized sentence chunk, already de-framed from tag 0x03. */
export interface InboundAudioFrame {
  turnId: number;
  sentenceIndex: number;
  format: TtsAudioFormat;
  sampleRate: number;
  payload: ArrayBuffer;
}

export type ServerControl =
  | { type: 'ready'; sessionId: string; defaults: Record<string, unknown> }
  | { type: 'state'; state: VoiceSessionState; turnId: number }
  | { type: 'vad'; voiced: boolean }
  | { type: 'user_text'; turnId: number; text: string; final: boolean; speculative: boolean }
  | { type: 'assistant_text'; turnId: number; delta?: string; text: string; final: boolean }
  | { type: 'flush_audio'; turnId: number }
  | { type: 'audio_end'; turnId: number }
  | { type: 'calibration'; echoPeak: number; fullDuplexSafe: boolean }
  | { type: 'error'; error: string; retryable: boolean; reasonCode?: string }
  | { type: 'pong' };

export type ClientControl =
  | { type: 'start'; sessionId: string; config: RealtimeVoiceConfig }
  | { type: 'barge_in' }
  | { type: 'end_turn' }
  | { type: 'stop' }
  | { type: 'ping' };

export type ServerFrame =
  | { kind: 'control'; message: ServerControl }
  | { kind: 'audio'; frame: InboundAudioFrame };

export class VoiceProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceProtocolError';
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Declared, not an arrow: TypeScript only narrows control flow after a
// never-returning call when the function has an explicit declaration like this.
function fail(message: string): never {
  throw new VoiceProtocolError(message);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readString = (value: unknown, field: string): string => {
  if (typeof value !== 'string') fail(`control frame field "${field}" must be a string`);
  return value;
};

const readNumber = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`control frame field "${field}" must be a finite number`);
  }
  return value;
};

const readBoolean = (value: unknown, field: string): boolean => {
  if (typeof value !== 'boolean') fail(`control frame field "${field}" must be a boolean`);
  return value;
};

/** Turn ids are monotonically increasing integers so they fit the binary header. */
const readTurnId = (value: unknown, field = 'turnId'): number => {
  const turnId = readNumber(value, field);
  if (!Number.isInteger(turnId) || turnId < 0) {
    fail(`control frame field "${field}" must be a non-negative integer`);
  }
  return turnId;
};

const readOptionalString = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  return readString(value, field);
};

const readSessionState = (value: unknown): VoiceSessionState => {
  const state = readString(value, 'state');
  const known = VOICE_SESSION_STATES.find((candidate) => candidate === state);
  if (!known) fail(`control frame declared an unknown session state "${state}"`);
  return known;
};

/** `defaults` is informational; an absent object must not fail the session. */
const readDefaults = (value: unknown): Record<string, unknown> => {
  if (value === undefined) return {};
  if (!isRecord(value)) fail('control frame field "defaults" must be an object');
  return value;
};

export const encodeControlFrame = (message: ClientControl): ArrayBuffer => {
  const json = textEncoder.encode(JSON.stringify(message));
  const frame = new Uint8Array(1 + json.byteLength);
  frame[0] = VOICE_FRAME_CONTROL;
  frame.set(json, 1);
  return frame.buffer;
};

/**
 * Frame 100 ms of microphone PCM for the wire. The payload is copied, so the
 * caller keeps ownership of `pcm16` — capture transfers a fresh buffer per
 * frame, but the codec must not assume that.
 */
export const encodeMicAudioFrame = (pcm16: Int16Array, seq: number): ArrayBuffer => {
  if (pcm16.length !== MIC_AUDIO_FRAME_SAMPLES) {
    fail(`mic audio frame must carry exactly ${MIC_AUDIO_FRAME_SAMPLES} samples, got ${pcm16.length}`);
  }
  if (!Number.isInteger(seq) || seq < 0) {
    fail(`mic audio seq must be a non-negative integer, got ${seq}`);
  }

  const frame = new Uint8Array(MIC_AUDIO_HEADER_BYTES + pcm16.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint8(0, VOICE_FRAME_MIC_AUDIO);
  // setUint8/setUint32 take the value modulo 2**32, so a counter that runs past
  // u32 wraps on the wire instead of throwing mid-call.
  view.setUint32(1, seq, false);
  view.setUint32(5, MIC_AUDIO_SAMPLE_RATE, false);
  frame.set(new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength), MIC_AUDIO_HEADER_BYTES);
  return frame.buffer;
};

export const parseServerControl = (json: string): ServerControl => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    fail('control frame is not valid JSON');
  }
  if (!isRecord(parsed)) fail('control frame is not a JSON object');

  const type = parsed.type;
  if (typeof type !== 'string') fail('control frame is missing a string "type"');

  switch (type) {
    case 'ready':
      return {
        type,
        sessionId: readString(parsed.sessionId, 'sessionId'),
        defaults: readDefaults(parsed.defaults),
      };
    case 'state':
      return { type, state: readSessionState(parsed.state), turnId: readTurnId(parsed.turnId) };
    case 'vad':
      return { type, voiced: readBoolean(parsed.voiced, 'voiced') };
    case 'user_text':
      return {
        type,
        turnId: readTurnId(parsed.turnId),
        text: readString(parsed.text, 'text'),
        final: readBoolean(parsed.final, 'final'),
        speculative: readBoolean(parsed.speculative, 'speculative'),
      };
    case 'assistant_text':
      return {
        type,
        turnId: readTurnId(parsed.turnId),
        delta: readOptionalString(parsed.delta, 'delta'),
        text: readString(parsed.text, 'text'),
        final: readBoolean(parsed.final, 'final'),
      };
    case 'flush_audio':
    case 'audio_end':
      return { type, turnId: readTurnId(parsed.turnId) };
    case 'calibration':
      return {
        type,
        echoPeak: readNumber(parsed.echoPeak, 'echoPeak'),
        fullDuplexSafe: readBoolean(parsed.fullDuplexSafe, 'fullDuplexSafe'),
      };
    case 'error':
      return {
        type,
        error: readString(parsed.error, 'error'),
        retryable: readBoolean(parsed.retryable, 'retryable'),
        reasonCode: readOptionalString(parsed.reasonCode, 'reasonCode'),
      };
    case 'pong':
      return { type };
    default:
      return fail(`unknown control frame type "${type}"`);
  }
};

const decodeTtsAudioFrame = (bytes: Uint8Array): InboundAudioFrame => {
  if (bytes.byteLength < TTS_AUDIO_HEADER_BYTES) {
    fail(`tts audio frame is shorter than its ${TTS_AUDIO_HEADER_BYTES}-byte header`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format = view.getUint8(6);
  if (format !== TTS_FORMAT_PCM16 && format !== TTS_FORMAT_MP3) {
    fail(`tts audio frame declared unknown format ${format}`);
  }
  const sampleRate = view.getUint32(7, false);
  if (sampleRate === 0) fail('tts audio frame declared sampleRate 0');

  // Copy out of the socket buffer: the payload outlives this frame's decode, and
  // a subarray would keep the whole received message alive behind one chunk.
  const payload = bytes.slice(TTS_AUDIO_HEADER_BYTES);
  if (format === TTS_FORMAT_PCM16 && payload.byteLength % 2 !== 0) {
    fail('tts PCM16 payload has an odd byte length');
  }

  return {
    turnId: view.getUint32(1, false),
    sentenceIndex: view.getUint8(5),
    format,
    sampleRate,
    payload: payload.buffer,
  };
};

export const decodeServerFrame = (data: ArrayBuffer): ServerFrame => {
  const bytes = new Uint8Array(data);
  if (bytes.byteLength < 1) fail('voice frame is empty');

  const tag = bytes[0];
  if (tag === VOICE_FRAME_CONTROL) {
    return { kind: 'control', message: parseServerControl(textDecoder.decode(bytes.subarray(1))) };
  }
  if (tag === VOICE_FRAME_TTS_AUDIO) {
    return { kind: 'audio', frame: decodeTtsAudioFrame(bytes) };
  }
  // Tag 0x02 only ever travels upstream; receiving one means the peer disagrees
  // about the protocol, which is not something to guess past.
  return fail(`unknown voice frame tag 0x${tag.toString(16)}`);
};
