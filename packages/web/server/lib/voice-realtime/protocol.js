/**
 * Realtime voice wire protocol: endpoint path, limits, and the binary frame
 * codec. Pure — no I/O, no sockets, safe to unit-test and to import from both
 * the runtime and the session.
 *
 * Every WebSocket message on this endpoint is binary. Byte 0 is the frame tag:
 *
 *   0x01  control      both directions   tag | UTF-8 JSON control object
 *   0x02  mic audio    client -> server  tag | seq u32 BE | sampleRate u32 BE | PCM16LE mono
 *   0x03  TTS audio    server -> client  tag | turnId u32 BE | sentenceIndex u8
 *                                             | format u8 | sampleRate u32 BE | payload
 *
 * `seq` on 0x02 is a debug counter only. WebSocket over TCP is already ordered
 * and reliable, so there is no ack and no reorder buffer here — unlike the
 * dictation stream manager, which solves a problem this transport does not have.
 *
 * `turnId` on 0x03 is the barge-in gate. It is a monotonically increasing
 * integer (not a string) so it fits the binary header directly and comparisons
 * at every await boundary are cheap. The send site re-checks it before writing,
 * and the client re-checks it on receipt, so audio from an interrupted turn
 * cannot reach the speakers.
 *
 * `format` on 0x03 is 0 for raw PCM16LE (a WAV body with the 44-byte header
 * stripped server-side) and 1 for the MP3 degradation fallback.
 */

export const VOICE_REALTIME_WS_PATH = '/api/voice/realtime';

/**
 * Inbound mic frames are 100 ms of 16 kHz mono PCM16 (3200 bytes + header).
 * Outbound TTS frames carry one synthesized sentence of 24 kHz mono PCM16; the
 * sentence chunker's `maxChars` bounds that to well under 1 MiB. The limit is
 * therefore driven by the downstream direction.
 */
export const VOICE_REALTIME_WS_MAX_PAYLOAD_BYTES = 1024 * 1024;

export const VOICE_REALTIME_WS_HEARTBEAT_INTERVAL_MS = 30000;

export const VOICE_REALTIME_FRAME_CONTROL = 0x01;
export const VOICE_REALTIME_FRAME_CLIENT_AUDIO = 0x02;
export const VOICE_REALTIME_FRAME_SERVER_AUDIO = 0x03;

/** 0 = raw PCM16LE (WAV body, header stripped); 1 = MP3 fallback. */
export const VOICE_REALTIME_AUDIO_FORMAT_PCM16 = 0;
export const VOICE_REALTIME_AUDIO_FORMAT_MP3 = 1;

export const VOICE_REALTIME_CLIENT_AUDIO_HEADER_BYTES = 9;
export const VOICE_REALTIME_SERVER_AUDIO_HEADER_BYTES = 11;

/** Nominal capture rate: 1600 samples per 100 ms frame. */
export const VOICE_REALTIME_MIC_SAMPLE_RATE = 16000;
export const VOICE_REALTIME_MIC_FRAME_MS = 100;

const MAX_UINT32 = 0xffffffff;
const MAX_UINT8 = 0xff;

const assertUint32 = (value, field) => {
  if (!Number.isInteger(value) || value < 0 || value > MAX_UINT32) {
    throw new TypeError(`${field} must be a uint32, got ${String(value)}`);
  }
};

const assertUint8 = (value, field) => {
  if (!Number.isInteger(value) || value < 0 || value > MAX_UINT8) {
    throw new TypeError(`${field} must be a uint8, got ${String(value)}`);
  }
};

const asBuffer = (value) => {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return Buffer.alloc(0);
};

/**
 * The audio payloads start at odd byte offsets (9 and 11) by construction, and
 * the parent message's own byteOffset is arbitrary, so a plain subarray is
 * frequently NOT 2-byte aligned — and `new Int16Array(buf.buffer,
 * buf.byteOffset, n)` throws on an odd offset. Decoders therefore hand back an
 * aligned view, copying only when they have to, so consumers can read samples
 * directly.
 * @param {Buffer} buf
 * @param {number} offset
 * @returns {Buffer}
 */
const alignedPayload = (buf, offset) => {
  const view = buf.subarray(offset);
  return view.byteOffset % 2 === 0 ? view : Buffer.from(view);
};

const assertAudioFormat = (format) => {
  if (format !== VOICE_REALTIME_AUDIO_FORMAT_PCM16 && format !== VOICE_REALTIME_AUDIO_FORMAT_MP3) {
    throw new TypeError(`format must be 0 (PCM16LE) or 1 (MP3), got ${String(format)}`);
  }
};

/**
 * Read the frame tag off any inbound message without copying it.
 * @param {Buffer|Uint8Array|null|undefined} message
 * @returns {number|null} the tag, or null when the message is not a frame
 */
export function frameTagOf(message) {
  if (!message || message.length < 1) {
    return null;
  }
  const tag = message[0];
  if (
    tag !== VOICE_REALTIME_FRAME_CONTROL
    && tag !== VOICE_REALTIME_FRAME_CLIENT_AUDIO
    && tag !== VOICE_REALTIME_FRAME_SERVER_AUDIO
  ) {
    return null;
  }
  return tag;
}

/**
 * Encode a control object as a tag-0x01 frame.
 * @param {object} message
 * @returns {Buffer}
 */
export function encodeControl(message) {
  if (!message || typeof message !== 'object') {
    throw new TypeError('control message must be an object');
  }
  const json = Buffer.from(JSON.stringify(message), 'utf8');
  const frame = Buffer.allocUnsafe(1 + json.length);
  frame[0] = VOICE_REALTIME_FRAME_CONTROL;
  json.copy(frame, 1);
  return frame;
}

/**
 * Decode a tag-0x01 frame. Returns null for a malformed frame rather than
 * throwing: a bad control message drops that message, not the connection.
 * @param {Buffer|Uint8Array} frame
 * @returns {object|null}
 */
export function decodeControl(frame) {
  const buf = asBuffer(frame);
  if (frameTagOf(buf) !== VOICE_REALTIME_FRAME_CONTROL) {
    return null;
  }
  try {
    const parsed = JSON.parse(buf.subarray(1).toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Encode a tag-0x02 client mic audio frame.
 * @param {{ seq: number, sampleRate: number, pcm: Buffer|Uint8Array }} params
 * @returns {Buffer}
 */
export function encodeClientAudio({ seq, sampleRate, pcm }) {
  assertUint32(seq, 'seq');
  assertUint32(sampleRate, 'sampleRate');
  const payload = asBuffer(pcm);
  const frame = Buffer.allocUnsafe(VOICE_REALTIME_CLIENT_AUDIO_HEADER_BYTES + payload.length);
  frame[0] = VOICE_REALTIME_FRAME_CLIENT_AUDIO;
  frame.writeUInt32BE(seq >>> 0, 1);
  frame.writeUInt32BE(sampleRate >>> 0, 5);
  payload.copy(frame, VOICE_REALTIME_CLIENT_AUDIO_HEADER_BYTES);
  return frame;
}

/**
 * Decode a tag-0x02 client mic audio frame. The returned `pcm` is a 2-byte
 * aligned view into the frame (copied only when the frame's own offset makes
 * that impossible), so callers that retain it past the next message must copy.
 * @param {Buffer|Uint8Array} frame
 * @returns {{ seq: number, sampleRate: number, pcm: Buffer }|null}
 */
export function decodeClientAudio(frame) {
  const buf = asBuffer(frame);
  if (frameTagOf(buf) !== VOICE_REALTIME_FRAME_CLIENT_AUDIO) {
    return null;
  }
  if (buf.length < VOICE_REALTIME_CLIENT_AUDIO_HEADER_BYTES) {
    return null;
  }
  const pcmLength = buf.length - VOICE_REALTIME_CLIENT_AUDIO_HEADER_BYTES;
  // PCM16 samples are two bytes; a truncated frame is a client bug, not audio.
  if (pcmLength % 2 !== 0) {
    return null;
  }
  return {
    seq: buf.readUInt32BE(1),
    sampleRate: buf.readUInt32BE(5),
    pcm: alignedPayload(buf, VOICE_REALTIME_CLIENT_AUDIO_HEADER_BYTES),
  };
}

/**
 * Encode a tag-0x03 server TTS audio frame.
 * @param {{
 *   turnId: number,
 *   sentenceIndex: number,
 *   format: number,
 *   sampleRate: number,
 *   payload: Buffer|Uint8Array,
 * }} params
 * @returns {Buffer}
 */
export function encodeServerAudio({ turnId, sentenceIndex, format, sampleRate, payload }) {
  assertUint32(turnId, 'turnId');
  assertUint8(sentenceIndex, 'sentenceIndex');
  assertAudioFormat(format);
  assertUint32(sampleRate, 'sampleRate');
  const body = asBuffer(payload);
  const frame = Buffer.allocUnsafe(VOICE_REALTIME_SERVER_AUDIO_HEADER_BYTES + body.length);
  frame[0] = VOICE_REALTIME_FRAME_SERVER_AUDIO;
  frame.writeUInt32BE(turnId >>> 0, 1);
  frame[5] = sentenceIndex;
  frame[6] = format;
  frame.writeUInt32BE(sampleRate >>> 0, 7);
  body.copy(frame, VOICE_REALTIME_SERVER_AUDIO_HEADER_BYTES);
  return frame;
}

/**
 * Decode a tag-0x03 server TTS audio frame. Mirrors `decodeClientAudio` so the
 * codec round-trips in tests; the client implements the same layout in
 * TypeScript.
 * @param {Buffer|Uint8Array} frame
 * @returns {{
 *   turnId: number,
 *   sentenceIndex: number,
 *   format: number,
 *   sampleRate: number,
 *   payload: Buffer,
 * }|null}
 */
export function decodeServerAudio(frame) {
  const buf = asBuffer(frame);
  if (frameTagOf(buf) !== VOICE_REALTIME_FRAME_SERVER_AUDIO) {
    return null;
  }
  if (buf.length < VOICE_REALTIME_SERVER_AUDIO_HEADER_BYTES) {
    return null;
  }
  return {
    turnId: buf.readUInt32BE(1),
    sentenceIndex: buf[5],
    format: buf[6],
    sampleRate: buf.readUInt32BE(7),
    payload: alignedPayload(buf, VOICE_REALTIME_SERVER_AUDIO_HEADER_BYTES),
  };
}
