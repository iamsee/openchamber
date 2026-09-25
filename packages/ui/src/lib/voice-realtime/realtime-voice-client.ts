/**
 * WebSocket transport for a realtime voice session (/api/voice/realtime).
 *
 * Connects the way dictation does: mint the URL-scoped auth token, resolve the
 * URL through the runtime resolver, open through the shared runtime socket helper
 * so relay mode carries this socket too (dictation-client.ts:108-124 and the
 * relay-transport skill: a raw `new WebSocket` against a runtime URL fails in
 * relay mode). Every message is binary; see protocol.ts for the layout.
 *
 * One client per session rather than an app-wide singleton: a voice conversation
 * has exactly one owner and one lifetime, so idle-close timing and refcounting
 * would only obscure when the socket is actually torn down.
 *
 * There is no connection-status callback in the contract. An unexpected socket
 * close is reported through the control channel the caller already listens to, as
 * an `error` message with reasonCode `transport_closed` (or `runtime_changed`),
 * so connection loss and server-reported errors take one path instead of two.
 */

import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { openRuntimeWebSocket } from '@/lib/relay/runtime-socket';
import { type RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';
import {
  decodeServerFrame,
  encodeControlFrame,
  encodeMicAudioFrame,
  VOICE_REALTIME_WS_PATH,
  type ClientControl,
  type InboundAudioFrame,
  type ServerControl,
  type ServerFrame,
} from './protocol';

export type {
  ClientControl,
  InboundAudioFrame,
  RealtimeVoiceConfig,
  ServerControl,
  TtsAudioFormat,
  VoiceSessionState,
} from './protocol';

/** Synthetic `error.reasonCode` for a socket that died under us. */
export const VOICE_TRANSPORT_CLOSED_REASON_CODE = 'transport_closed';
/** Synthetic `error.reasonCode` for a runtime switch tearing the socket down. */
export const VOICE_RUNTIME_CHANGED_REASON_CODE = 'runtime_changed';

export interface RealtimeVoiceClient {
  /** Resolves when the socket is open. The caller then sends `start`. */
  connect(): Promise<void>;
  sendControl(msg: ClientControl): void;
  /** Encodes tag 0x02. Drops the frame with one warning if the socket is not open. */
  sendAudio(pcm16: Int16Array, seq: number): void;
  onControl(cb: (m: ServerControl) => void): () => void;
  onAudio(cb: (f: InboundAudioFrame) => void): () => void;
  /** Terminal: a closed client cannot reconnect. Create a new one per session. */
  close(): void;
}

const CONNECT_TIMEOUT_MS = 10000;
/** How long `onerror` waits for the richer `onclose` reason before failing. */
const ERROR_CLOSE_DELAY_MS = 250;
const RUNTIME_ENDPOINT_CHANGED_EVENT = 'openchamber:runtime-endpoint-changed';
/** Distinct warnings per client; a broken stream must not grow this forever. */
const MAX_DISTINCT_WARNINGS = 8;

const toError = (value: unknown): Error => (value instanceof Error ? value : new Error(String(value)));

export const createRealtimeVoiceClient = (): RealtimeVoiceClient => {
  const controlListeners = new Set<(message: ServerControl) => void>();
  const audioListeners = new Set<(frame: InboundAudioFrame) => void>();
  const warnings = new Set<string>();

  let socket: RelayTunnelWebSocket | null = null;
  let connectPromise: Promise<void> | null = null;
  let rejectPendingConnect: ((error: Error) => void) | null = null;
  let closedByCaller = false;
  let runtimeListenerAttached = false;

  const warnOnce = (message: string): void => {
    if (warnings.has(message) || warnings.size >= MAX_DISTINCT_WARNINGS) {
      return;
    }
    warnings.add(message);
    console.warn(`[voice-realtime] ${message}`);
  };

  const emitControl = (message: ServerControl): void => {
    for (const listener of controlListeners) {
      listener(message);
    }
  };

  const detachSocket = (reason: string): void => {
    const active = socket;
    socket = null;
    if (!active) {
      return;
    }
    active.onopen = null;
    active.onmessage = null;
    active.onerror = null;
    active.onclose = null;
    try {
      active.close(1000, reason);
    } catch {
      // The socket may already be closed; teardown must not throw into a caller.
    }
  };

  const failPendingConnect = (error: Error): void => {
    const reject = rejectPendingConnect;
    rejectPendingConnect = null;
    if (reject) {
      reject(error);
    }
  };

  const handleMessage = (data: string | ArrayBuffer): void => {
    if (typeof data === 'string') {
      warnOnce('dropped a text frame; the realtime voice protocol is binary-only');
      return;
    }

    let decoded: ServerFrame;
    try {
      decoded = decodeServerFrame(data);
    } catch (error) {
      // A malformed frame is dropped, not fatal: killing the socket would end a
      // live conversation over one bad chunk.
      warnOnce(`dropped a malformed inbound frame: ${toError(error).message}`);
      return;
    }

    if (decoded.kind === 'control') {
      emitControl(decoded.message);
      return;
    }
    for (const listener of audioListeners) {
      listener(decoded.frame);
    }
  };

  const sendFrame = (frame: ArrayBuffer): void => {
    const active = socket;
    if (!active || active.readyState !== WebSocket.OPEN) {
      warnOnce('dropped an outbound frame: the socket is not open');
      return;
    }
    try {
      active.send(frame);
    } catch (error) {
      warnOnce(`dropped an outbound frame: ${toError(error).message}`);
    }
  };

  const handleRuntimeEndpointChanged = (): void => {
    // The resolved URL and the oc_url_token both belong to the previous runtime,
    // so the socket has to go; the next connect() re-resolves both. The
    // conversation state lived on the old runtime and does not survive this —
    // the caller has to start a new session.
    detachSocket('runtime switch');
    failPendingConnect(new Error('[voice-realtime] runtime changed while connecting'));
    emitControl({
      type: 'error',
      error: 'Runtime changed; the voice session ended',
      retryable: true,
      reasonCode: VOICE_RUNTIME_CHANGED_REASON_CODE,
    });
  };

  const attachRuntimeListener = (): void => {
    if (runtimeListenerAttached || typeof window === 'undefined') {
      return;
    }
    runtimeListenerAttached = true;
    window.addEventListener(RUNTIME_ENDPOINT_CHANGED_EVENT, handleRuntimeEndpointChanged);
  };

  const removeRuntimeListener = (): void => {
    if (!runtimeListenerAttached || typeof window === 'undefined') {
      return;
    }
    runtimeListenerAttached = false;
    window.removeEventListener(RUNTIME_ENDPOINT_CHANGED_EVENT, handleRuntimeEndpointChanged);
  };

  const openSocket = async (): Promise<void> => {
    // A WebSocket upgrade cannot carry an Authorization header, so it
    // authenticates with the short-lived oc_url_token query param. Mint it BEFORE
    // resolving the URL: the sync getter returns "" while the token is unminted
    // or inside its expiry skew, and the server would reject the upgrade with 401.
    try {
      await refreshRuntimeUrlAuthToken();
    } catch {
      // No auth configured (local runtime) — proceed without a token.
    }
    if (closedByCaller) {
      throw new Error('[voice-realtime] client is closed');
    }

    await new Promise<void>((resolve, reject) => {
      let opened: RelayTunnelWebSocket;
      try {
        opened = openRuntimeWebSocket(getRuntimeUrlResolver().websocket(VOICE_REALTIME_WS_PATH));
      } catch (error) {
        reject(toError(error));
        return;
      }

      // Binary in both directions. The tunnel always delivers ArrayBuffer, but a
      // native socket defaults to Blob — and the shared wrapper drops Blob data
      // instead of forwarding it, so this line is what makes audio arrive at all.
      opened.binaryType = 'arraybuffer';
      socket = opened;

      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let errorTimer: ReturnType<typeof setTimeout> | null = null;

      const settleFailure = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        if (errorTimer) {
          clearTimeout(errorTimer);
        }
        rejectPendingConnect = null;
        if (socket === opened) {
          detachSocket('connect failed');
        }
        reject(error);
      };

      timeout = setTimeout(() => {
        settleFailure(new Error('[voice-realtime] connection timed out'));
      }, CONNECT_TIMEOUT_MS);
      rejectPendingConnect = settleFailure;

      opened.onopen = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        if (errorTimer) {
          clearTimeout(errorTimer);
        }
        rejectPendingConnect = null;
        resolve();
      };

      opened.onmessage = (event) => {
        handleMessage(event.data);
      };

      opened.onerror = () => {
        // Prefer onclose, which follows with the real reason. But if a socket
        // errors without a prompt close, fail fast rather than burning the whole
        // connect timeout — dictation-client.ts:167-179 for the same reason.
        if (settled || errorTimer) {
          return;
        }
        errorTimer = setTimeout(() => {
          settleFailure(new Error('[voice-realtime] connection failed'));
        }, ERROR_CLOSE_DELAY_MS);
      };

      opened.onclose = (event) => {
        if (!settled) {
          const detail = event.reason ? `: ${event.reason}` : '';
          settleFailure(new Error(`[voice-realtime] connection failed${detail}`));
          return;
        }
        if (socket === opened) {
          socket = null;
        }
        if (closedByCaller) {
          return;
        }
        emitControl({
          type: 'error',
          error: `Realtime voice connection lost${event.reason ? `: ${event.reason}` : ''}`,
          retryable: true,
          reasonCode: VOICE_TRANSPORT_CLOSED_REASON_CODE,
        });
      };
    });
  };

  const connect = (): Promise<void> => {
    if (closedByCaller) {
      return Promise.reject(new Error('[voice-realtime] client is closed'));
    }
    if (socket && socket.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (connectPromise) {
      return connectPromise;
    }
    attachRuntimeListener();
    connectPromise = openSocket().finally(() => {
      connectPromise = null;
    });
    return connectPromise;
  };

  const sendControl = (msg: ClientControl): void => {
    let frame: ArrayBuffer;
    try {
      frame = encodeControlFrame(msg);
    } catch (error) {
      warnOnce(`dropped control frame "${msg.type}": ${toError(error).message}`);
      return;
    }
    sendFrame(frame);
  };

  const sendAudio = (pcm16: Int16Array, seq: number): void => {
    let frame: ArrayBuffer;
    try {
      frame = encodeMicAudioFrame(pcm16, seq);
    } catch (error) {
      // The codec owns the frame-size and seq invariants; a capture bug must not
      // throw inside the worklet's message handler ten times a second.
      warnOnce(`dropped a mic frame: ${toError(error).message}`);
      return;
    }
    sendFrame(frame);
  };

  const onControl = (cb: (m: ServerControl) => void): (() => void) => {
    controlListeners.add(cb);
    return () => {
      controlListeners.delete(cb);
    };
  };

  const onAudio = (cb: (f: InboundAudioFrame) => void): (() => void) => {
    audioListeners.add(cb);
    return () => {
      audioListeners.delete(cb);
    };
  };

  const close = (): void => {
    if (closedByCaller) {
      return;
    }
    closedByCaller = true;
    removeRuntimeListener();
    detachSocket('client closed');
    connectPromise = null;
    controlListeners.clear();
    audioListeners.clear();
    failPendingConnect(new Error('[voice-realtime] client closed while connecting'));
  };

  return { connect, sendControl, sendAudio, onControl, onAudio, close };
};
