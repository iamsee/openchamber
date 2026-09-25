/**
 * Switchable LLM adapter for the realtime voice turn.
 *
 * `assistant` is the full-duplex brain that ships now: an OpenAI-compatible
 * `POST {baseUrl}/chat/completions` with `stream: true`, parsed by hand off the
 * response body. The OpenAI SDK is deliberately not used here — the SDK buffers
 * and re-wraps the stream, and this path needs the first token on the wire with
 * as little machinery between it and the sentence chunker as possible.
 *
 * `session` (the half-duplex push-to-talk brain that drives an OpenCode agent
 * run) is a typed stub in this change. It is a separate state machine: barge-in
 * there means cancelling an agent run, which must be an explicit confirmed user
 * action and never VAD-triggered, so it does not share this pipeline.
 *
 * Every outbound URL goes through `normalizeCustomOpenAIBaseURL`, which means
 * the existing SSRF guard applies: a non-loopback host is rejected unless
 * `OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS=true` (or the runtime is the
 * desktop build). The documented default assistant brain is a remote relay, so
 * that flag is required for it — same rule the dictation and TTS providers
 * already follow.
 */

import { normalizeCustomOpenAIBaseURL } from '../tts/base-url.js';

export const BRAIN_MODE_ASSISTANT = 'assistant';
export const BRAIN_MODE_SESSION = 'session';

/**
 * Thrown for a brain mode that is specified but not implemented in this
 * change. Typed so the session can turn it into a non-retryable protocol error
 * instead of a generic 500-style failure.
 */
export class VoiceRealtimeNotImplementedError extends Error {
  /**
   * @param {string} message
   * @param {string} reasonCode
   */
  constructor(message, reasonCode) {
    super(message);
    this.name = 'VoiceRealtimeNotImplementedError';
    this.reasonCode = reasonCode;
    this.retryable = false;
  }
}

export const DEFAULT_ASSISTANT_SYSTEM_PROMPT = [
  '你是一个实时语音对话助手，用户正在用中文进行免手持语音对话。',
  '必须用简体中文回答，回答要口语化、简短，一次不超过两到三句话，像真人对话。',
  '禁止使用 markdown、标题、列表（项目符号或编号）、代码块、表格、emoji 或网址——你写的每个字都会被文字转语音朗读。',
  '不要把标点符号拼写出来。如果用户要代码或长文档，简短说明你会发到聊天框里而不是朗读。',
].join(' ');

const resolveApiKey = (apiKey) => apiKey || process.env.OPENCHAMBER_VOICE_LLM_KEY || process.env.OPENAI_API_KEY || 'not-required';

/**
 * Pull the text delta out of one streamed chat-completion chunk. Handles the
 * OpenAI streaming shape, a gateway that ignores `stream` and returns a whole
 * message, and the legacy `text` field some proxies still emit.
 * @param {unknown} payload
 * @returns {string}
 */
function extractDeltaText(payload) {
  if (!payload || typeof payload !== 'object') {
    return '';
  }
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
  if (!choice || typeof choice !== 'object') {
    return '';
  }
  const deltaContent = choice.delta?.content;
  if (typeof deltaContent === 'string') {
    return deltaContent;
  }
  const messageContent = choice.message?.content;
  if (typeof messageContent === 'string') {
    return messageContent;
  }
  return typeof choice.text === 'string' ? choice.text : '';
}

/**
 * Split a raw SSE buffer into complete events, returning the leftover partial
 * tail. Events are separated by a blank line; `data:` fields within one event
 * are joined with a newline per the SSE spec.
 * @param {string} buffer
 * @returns {{ events: string[], rest: string }}
 */
export function splitSseEvents(buffer) {
  const events = [];
  let rest = buffer;
  for (;;) {
    const match = /\r?\n\r?\n/.exec(rest);
    if (!match) {
      break;
    }
    const rawEvent = rest.slice(0, match.index);
    rest = rest.slice(match.index + match[0].length);
    const dataLines = [];
    for (const line of rawEvent.split(/\r?\n/)) {
      if (!line.startsWith('data:')) {
        continue;
      }
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (dataLines.length > 0) {
      events.push(dataLines.join('\n'));
    }
  }
  return { events, rest };
}

/**
 * @param {object} options
 * @param {string} [options.mode] 'assistant' (default) or 'session'
 * @param {string} options.baseUrl OpenAI-compatible base URL including `/v1`
 * @param {string} [options.apiKey]
 * @param {string} options.model
 * @param {string} [options.systemPrompt]
 * @param {number} [options.temperature]
 * @param {number} [options.maxTokens]
 * @param {typeof fetch} [options.fetchImpl] injection seam for tests
 * @param {number} [options.stallTimeoutMs] abort if no bytes arrive, default 60000
 */
export function createBrain(options) {
  const {
    mode = BRAIN_MODE_ASSISTANT,
    baseUrl,
    apiKey,
    model,
    systemPrompt = DEFAULT_ASSISTANT_SYSTEM_PROMPT,
    temperature = 0.7,
    maxTokens = 512,
    fetchImpl = fetch,
    stallTimeoutMs = 60000,
  } = options;

  if (mode === BRAIN_MODE_SESSION) {
    throw new VoiceRealtimeNotImplementedError(
      'The "session" brain (half-duplex push-to-talk against an OpenCode agent run) is not implemented in this change.',
      'session_brain_not_implemented',
    );
  }
  if (mode !== BRAIN_MODE_ASSISTANT) {
    throw new VoiceRealtimeNotImplementedError(
      `Unknown realtime voice brain mode: ${String(mode)}`,
      'unknown_brain_mode',
    );
  }

  const normalized = normalizeCustomOpenAIBaseURL(baseUrl);
  if (normalized.error) {
    throw new Error(normalized.error);
  }
  if (!normalized.value) {
    throw new Error('Assistant brain base URL is required');
  }
  if (!model) {
    throw new Error('Assistant brain model is required');
  }
  const completionsUrl = `${normalized.value}/chat/completions`;

  let activeController = null;

  /**
   * Stream one assistant reply as text deltas.
   * @param {Array<{role: string, content: string}>} messages
   * @param {{ signal?: AbortSignal }} [callOptions]
   * @returns {AsyncGenerator<string, void, void>}
   */
  async function* stream(messages, callOptions = {}) {
    const outerSignal = callOptions.signal;
    const controller = new AbortController();
    activeController = controller;

    const onOuterAbort = () => controller.abort(outerSignal?.reason);
    if (outerSignal) {
      if (outerSignal.aborted) {
        controller.abort(outerSignal.reason);
      } else {
        outerSignal.addEventListener('abort', onOuterAbort, { once: true });
      }
    }
    let stallTimer = setTimeout(() => controller.abort(new Error('assistant brain stalled')), stallTimeoutMs);
    const bumpStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => controller.abort(new Error('assistant brain stalled')), stallTimeoutMs);
    };

    try {
      const response = await fetchImpl(completionsUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${resolveApiKey(apiKey)}`,
        },
        body: JSON.stringify({
          model,
          stream: true,
          temperature,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: systemPrompt },
            ...messages,
          ],
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => '');
        const error = new Error(
          `assistant brain request failed: ${response.status} ${response.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}`,
        );
        error.reasonCode = 'brain_request_failed';
        error.status = response.status;
        throw error;
      }

      bumpStall();
      // One streaming decoder for the whole response: chunk boundaries can
      // fall inside a multi-byte UTF-8 sequence, and decoding each chunk on
      // its own would corrupt CJK output into replacement characters.
      const decoder = new TextDecoder('utf-8');
      let sseBuffer = '';
      let done = false;
      for await (const chunk of response.body) {
        bumpStall();
        if (controller.signal.aborted) {
          return;
        }
        sseBuffer += decoder.decode(chunk, { stream: true });
        const { events, rest } = splitSseEvents(sseBuffer);
        sseBuffer = rest;
        for (const event of events) {
          if (event.trim() === '[DONE]') {
            done = true;
            break;
          }
          let payload;
          try {
            payload = JSON.parse(event);
          } catch {
            continue;
          }
          if (payload?.error) {
            const error = new Error(
              `assistant brain stream error: ${payload.error.message || JSON.stringify(payload.error).slice(0, 200)}`,
            );
            error.reasonCode = 'brain_stream_error';
            throw error;
          }
          const delta = extractDeltaText(payload);
          if (delta) {
            yield delta;
          }
        }
        if (done) {
          break;
        }
      }

      // A gateway that closed the stream without [DONE] can still be holding
      // the last event in the buffer with no trailing blank line.
      const tail = sseBuffer.trim();
      if (!done && tail.startsWith('data:')) {
        const body = tail.slice(5).replace(/^ /, '').trim();
        if (body && body !== '[DONE]') {
          try {
            const delta = extractDeltaText(JSON.parse(body));
            if (delta) {
              yield delta;
            }
          } catch {
            // truncated final event; the stream is over either way
          }
        }
      }
    } finally {
      clearTimeout(stallTimer);
      outerSignal?.removeEventListener('abort', onOuterAbort);
      if (activeController === controller) {
        activeController = null;
      }
    }
  }

  return {
    mode: BRAIN_MODE_ASSISTANT,
    completionsUrl,
    stream,
    /** Cancel the in-flight completion, if any. */
    abort(reason) {
      activeController?.abort(reason);
    },
  };
}
