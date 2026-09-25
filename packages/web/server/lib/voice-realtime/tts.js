/**
 * Per-sentence speech synthesis for the realtime voice pipeline.
 *
 * `lib/tts/service.js` cannot be reused here: it buffers the whole response
 * (`await response.arrayBuffer()`) and, with a custom baseURL, sends no
 * `response_format` at all. A realtime turn needs the first bytes of a sentence
 * on the wire as soon as the backend produces them, so this module streams the
 * response body and yields audio incrementally.
 *
 * Container decision (measured against the target backend, see
 * DOCUMENTATION.md): `response_format: 'wav'` returns RIFF WAVE / Microsoft
 * PCM / 16-bit / mono / 24000 Hz. `pcm` and `opus` are 500s there. WAV is the
 * primary path — zero codec delay or padding, so sentences concatenate
 * sample-exactly with no rhythmic stutter, and stripping the 44-byte header
 * server-side lets the client write samples straight into an AudioBuffer
 * instead of paying a main-thread `decodeAudioData`. It is also faster than
 * MP3 (1.10 s vs 1.32 s for the same 12-char sentence) because the encode step
 * is skipped.
 *
 * MP3 is kept purely as a degradation fallback for a backend that refuses WAV.
 * Silence trimming (`trimPcm16NearSilence`) applies to PCM payloads only: MP3
 * codec padding lives inside the compressed frames, and this server has no MP3
 * decoder and takes no new dependencies, so that trim is the client's job on
 * the fallback path.
 */

import { normalizeCustomOpenAIBaseURL } from '../tts/base-url.js';

export const TTS_RESPONSE_FORMAT_WAV = 'wav';
export const TTS_RESPONSE_FORMAT_MP3 = 'mp3';

const WAV_HEADER_MAX_BYTES = 64 * 1024;
const WAVE_FORMAT_PCM = 1;
const WAV_HEADER_SIZE = 44;

/**
 * Locate the `data` chunk in a RIFF WAVE buffer and read the format out of
 * `fmt `. Handles the canonical 44-byte header and a header with extra chunks
 * (LIST/fact) before `data`.
 *
 * @param {Buffer} buffer
 * @returns {{ sampleRate: number, dataOffset: number }|{ error: string }}
 */
export function parseWavHeader(buffer) {
  if (buffer.length < WAV_HEADER_SIZE) {
    return { error: 'WAV header truncated' };
  }
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    return { error: 'not a RIFF WAVE container' };
  }

  let offset = 12;
  let sampleRate = 0;
  let sawFmt = false;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === 'fmt ') {
      if (offset + 24 > buffer.length) {
        return { error: 'WAV fmt chunk truncated' };
      }
      const audioFormat = buffer.readUInt16LE(offset + 8);
      const channels = buffer.readUInt16LE(offset + 10);
      sampleRate = buffer.readUInt32LE(offset + 12);
      const bitsPerSample = buffer.readUInt16LE(offset + 22);
      if (audioFormat !== WAVE_FORMAT_PCM) {
        return { error: `unsupported WAV audio format ${audioFormat}` };
      }
      if (channels !== 1) {
        return { error: `expected mono WAV, got ${channels} channels` };
      }
      if (bitsPerSample !== 16) {
        return { error: `expected 16-bit WAV, got ${bitsPerSample}-bit` };
      }
      sawFmt = true;
      offset += 8 + chunkSize + (chunkSize % 2);
      continue;
    }
    if (chunkId === 'data') {
      if (!sawFmt) {
        return { error: 'WAV data chunk before fmt chunk' };
      }
      if (!(sampleRate > 0)) {
        return { error: 'WAV header carries no sample rate' };
      }
      return { sampleRate, dataOffset: offset + 8 };
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  return { error: 'WAV header carries no data chunk' };
}

/**
 * Return an Int16Array view over a PCM16LE buffer, copying when the buffer's
 * byteOffset is not 2-byte aligned. Mirrors the private helper in
 * ../dictation/audio.js.
 * @param {Buffer} pcm16le
 * @returns {Int16Array}
 */
function toInt16Samples(pcm16le) {
  if (pcm16le.byteOffset % 2 !== 0) {
    const copy = Buffer.from(pcm16le);
    return new Int16Array(copy.buffer, copy.byteOffset, copy.byteLength / 2);
  }
  return new Int16Array(pcm16le.buffer, pcm16le.byteOffset, pcm16le.byteLength / 2);
}

/**
 * Trim near-silent samples from both ends of a PCM16LE buffer. Used only on
 * the MP3 degradation path's decoded output and on backends that pad PCM; the
 * WAV path needs no trim because the container adds no codec delay.
 *
 * @param {Buffer} pcm16le
 * @param {{ threshold?: number, maxTrimSamples?: number }} [options]
 * @returns {Buffer}
 */
export function trimPcm16NearSilence(pcm16le, options = {}) {
  const threshold = options.threshold ?? 160;
  const samples = toInt16Samples(pcm16le);
  const maxTrim = Math.min(options.maxTrimSamples ?? samples.length, samples.length);

  let start = 0;
  while (start < maxTrim && Math.abs(samples[start]) <= threshold) {
    start += 1;
  }
  let end = samples.length;
  while (end > samples.length - maxTrim && end > start && Math.abs(samples[end - 1]) <= threshold) {
    end -= 1;
  }
  if (start === 0 && end === samples.length) {
    return pcm16le;
  }
  return pcm16le.subarray(start * 2, end * 2);
}

const resolveApiKey = (apiKey) => apiKey || process.env.OPENCHAMBER_VOICE_TTS_KEY || process.env.OPENAI_API_KEY || 'not-required';

/**
 * @param {object} options
 * @param {string} options.baseUrl OpenAI-compatible base URL including `/v1`
 * @param {string} [options.apiKey]
 * @param {string} options.model
 * @param {string} options.voice
 * @param {number} [options.speed]
 * @param {string} [options.responseFormat] 'wav' (default) or 'mp3'
 * @param {typeof fetch} [options.fetchImpl] injection seam for tests
 * @param {number} [options.timeoutMs] per-request guard, default 30000
 * @param {boolean} [options.trimPcmSilence] trim padded leading silence off PCM payloads, default false
 */
export function createTtsSynthesizer(options) {
  const {
    baseUrl,
    apiKey,
    model,
    voice,
    speed = 1,
    responseFormat = TTS_RESPONSE_FORMAT_WAV,
    fetchImpl = fetch,
    timeoutMs = 30000,
    trimPcmSilence = false,
  } = options;

  const normalized = normalizeCustomOpenAIBaseURL(baseUrl);
  if (normalized.error) {
    throw new Error(normalized.error);
  }
  if (!normalized.value) {
    throw new Error('TTS base URL is required');
  }
  const speechUrl = `${normalized.value}/audio/speech`;

  const openSpeechStream = async (format, text, signal) => {
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) {
        controller.abort(signal.reason);
      } else {
        signal.addEventListener('abort', onOuterAbort, { once: true });
      }
    }
    const timer = setTimeout(() => controller.abort(new Error('TTS request timed out')), timeoutMs);

    const detach = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
    };

    const response = await fetchImpl(speechUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${resolveApiKey(apiKey)}`,
      },
      body: JSON.stringify({ model, voice: process.env.OPENCHAMBER_VOICE_TTS_VOICE || voice || 'zf_001', input: text, speed, response_format: format }),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      detach();
      const detail = await response.text().catch(() => '');
      const error = new Error(
        `TTS ${format} request failed: ${response.status} ${response.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`,
      );
      error.reasonCode = 'tts_request_failed';
      error.status = response.status;
      throw error;
    }
    return { response, detach };
  };

  /**
   * Synthesize one sentence, yielding audio as it arrives.
   *
   * Yields `{ pcm, sampleRate }` for raw PCM16LE frames (the WAV path, with
   * the container header stripped) or `{ mp3 }` for the fallback path. Each
   * yielded PCM frame is one HTTP body chunk, so a long sentence reaches the
   * client as several WS frames sharing a `sentenceIndex`.
   *
   * @param {string} text
   * @param {{ signal?: AbortSignal }} [callOptions]
   * @returns {AsyncGenerator<{pcm: Buffer, sampleRate: number}|{mp3: Buffer}, void, void>}
   */
  async function* synthesize(text, callOptions = {}) {
    const signal = callOptions.signal;
    const trimmed = String(text ?? '').trim();
    if (!trimmed) {
      return;
    }

    // WAV first; a backend that refuses it (or returns something that is not
    // PCM16 mono) degrades to MP3 for this sentence rather than failing the
    // whole turn.
    const formats = responseFormat === TTS_RESPONSE_FORMAT_MP3
      ? [TTS_RESPONSE_FORMAT_MP3]
      : [TTS_RESPONSE_FORMAT_WAV, TTS_RESPONSE_FORMAT_MP3];

    let lastError = null;
    for (const format of formats) {
      if (signal?.aborted) {
        return;
      }
      let opened;
      try {
        opened = await openSpeechStream(format, trimmed, signal);
      } catch (error) {
        lastError = error;
        continue;
      }
      const { response, detach } = opened;
      try {
        if (format === TTS_RESPONSE_FORMAT_MP3) {
          for await (const chunk of response.body) {
            if (signal?.aborted) {
              return;
            }
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            if (bytes.length > 0) {
              yield { mp3: bytes };
            }
          }
          return;
        }

        let pending = Buffer.alloc(0);
        let header = null;
        let lastParseError = null;
        for await (const chunk of response.body) {
          if (signal?.aborted) {
            return;
          }
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (header) {
            if (bytes.length > 0) {
              yield { pcm: bytes, sampleRate: header.sampleRate };
            }
            continue;
          }
          pending = pending.length === 0 ? bytes : Buffer.concat([pending, bytes]);
          const parsed = parseWavHeader(pending);
          if (parsed.error) {
            // Not enough bytes yet to know: buffer more before deciding the
            // container is unusable.
            lastParseError = parsed.error;
            if (pending.length < WAV_HEADER_MAX_BYTES) {
              continue;
            }
            const error = new Error(`TTS wav response is not usable PCM16 mono: ${parsed.error}`);
            error.reasonCode = 'tts_wav_unsupported';
            throw error;
          }
          header = parsed;
          let body = Buffer.from(pending.subarray(parsed.dataOffset));
          pending = Buffer.alloc(0);
          // Opt-in degradation aid: a backend that pads its WAV body with
          // silence adds a gap before the first word of every sentence. Off by
          // default — the verified container needs no trim, and trimming
          // leading silence only is enough to remove a padded onset.
          if (trimPcmSilence && body.length > 0) {
            body = trimPcm16NearSilence(body);
          }
          if (body.length > 0) {
            yield { pcm: body, sampleRate: parsed.sampleRate };
          }
        }
        if (!header) {
          const detail = lastParseError ?? 'WAV header never completed';
          const error = new Error(`TTS wav response is not usable PCM16 mono: ${detail}`);
          error.reasonCode = 'tts_wav_unsupported';
          throw error;
        }
        return;
      } catch (error) {
        lastError = error;
        if (signal?.aborted || error?.name === 'AbortError') {
          return;
        }
        continue;
      } finally {
        detach();
      }
    }

    if (lastError) {
      throw lastError;
    }
  }

  return { synthesize, speechUrl };
}
