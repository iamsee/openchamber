/**
 * Realtime voice runtime: registers the full-duplex voice conversation
 * WebSocket endpoint at /api/voice/realtime.
 *
 * Wire protocol is binary — see ./protocol.js for the frame layouts and
 * ./DOCUMENTATION.md for the control messages. The upgrade path, auth gate,
 * heartbeat and teardown mirror ../dictation/runtime.js so both streaming
 * audio endpoints behave identically behind the UI auth controller, the relay
 * tunnel and a graceful shutdown.
 *
 * There are deliberately no HTTP routes here. Settings live in the existing
 * settings store and reach the server inside the client's `start` control
 * message; a second config endpoint would be a second source of truth.
 */

import { WebSocketServer } from 'ws';

import { createVoiceRealtimeSession } from './session.js';
import {
  decodeClientAudio,
  decodeControl,
  frameTagOf,
  VOICE_REALTIME_FRAME_CLIENT_AUDIO,
  VOICE_REALTIME_FRAME_CONTROL,
  VOICE_REALTIME_WS_HEARTBEAT_INTERVAL_MS,
  VOICE_REALTIME_WS_MAX_PAYLOAD_BYTES,
  VOICE_REALTIME_WS_PATH,
} from './protocol.js';

const parseRequestPathname = (url) => {
  try {
    return new URL(url, 'http://localhost').pathname;
  } catch {
    return typeof url === 'string' ? url.split('?')[0] : '';
  }
};

/**
 * @param {object} deps
 * @param {import('http').Server} deps.server
 * @param {object} [deps.uiAuthController]
 * @param {(req: unknown) => Promise<boolean>} deps.isRequestOriginAllowed
 * @param {(socket: unknown, status: number, reason: string) => void} deps.rejectWebSocketUpgrade
 * @param {object} [deps.config] server-side defaults merged under the client's `start.config`
 */
export function createVoiceRealtimeRuntime({
  server,
  uiAuthController,
  isRequestOriginAllowed,
  rejectWebSocketUpgrade,
  config = {},
}) {
  const wsServer = new WebSocketServer({
    noServer: true,
    maxPayload: VOICE_REALTIME_WS_MAX_PAYLOAD_BYTES,
  });

  const sessions = new Set();

  wsServer.on('connection', (socket) => {
    const session = createVoiceRealtimeSession({ socket, config });
    sessions.add(session);
    console.log('[voice-rt] WS connected (sessions=%d)', sessions.size);

    const heartbeatInterval = setInterval(() => {
      if (socket.readyState !== 1) {
        return;
      }
      try {
        socket.ping();
      } catch {
        // ignore
      }
    }, VOICE_REALTIME_WS_HEARTBEAT_INTERVAL_MS);

    let frameCount = 0;
    socket.on('message', (raw, isBinary) => {
      if (!isBinary) {
        return;
      }
      const tag = frameTagOf(raw);
      if (tag === VOICE_REALTIME_FRAME_CONTROL) {
        const message = decodeControl(raw);
        if (message) {
          if (message.type === 'start') console.log('[voice-rt] control: start brain=%s hasProviderKey=%s hasSttKey=%s hasTtsKey=%s', message.config && message.config.brain, !!(message.config && message.config.provider && message.config.provider.apiKey), !!(message.config && message.config.stt && message.config.stt.apiKey), !!(message.config && message.config.tts && message.config.tts.apiKey));
          else if (message.type === 'barge_in') console.log('[voice-rt] control: barge_in');
          else if (message.type === 'stop') console.log('[voice-rt] control: stop');
          session.handleControl(message);
        }
        return;
      }
      if (tag === VOICE_REALTIME_FRAME_CLIENT_AUDIO) {
        const frame = decodeClientAudio(raw);
        if (frame) {
          frameCount++;
          if (frameCount === 1) console.log('[voice-rt] first audio frame received (seq=%d, %d bytes)', frame.seq, raw.length);
          else if (frameCount % 50 === 0) console.log('[voice-rt] %d audio frames received', frameCount);
          session.handleAudioFrame(frame);
        }
      }
    });

    socket.on('close', () => {
      clearInterval(heartbeatInterval);
      sessions.delete(session);
      session.cleanup();
    });

    socket.on('error', () => {
      // 'close' follows and performs cleanup.
    });
  });

  const upgradeHandler = (req, socket, head) => {
    const pathname = parseRequestPathname(req.url);
    if (pathname !== VOICE_REALTIME_WS_PATH) {
      return;
    }

    const handleUpgrade = async () => {
      try {
        if (uiAuthController?.enabled) {
          const sessionToken = await uiAuthController?.ensureSessionToken?.(req, null);
          if (!sessionToken) {
            rejectWebSocketUpgrade(socket, 401, 'UI authentication required');
            return;
          }

          const originAllowed = await isRequestOriginAllowed(req);
          if (!originAllowed) {
            rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
            return;
          }
        }

        wsServer.handleUpgrade(req, socket, head, (ws) => {
          wsServer.emit('connection', ws, req);
        });
      } catch {
        rejectWebSocketUpgrade(socket, 500, 'Upgrade failed');
      }
    };

    void handleUpgrade();
  };

  server.on('upgrade', upgradeHandler);

  const stop = () => {
    server.off('upgrade', upgradeHandler);
    for (const session of sessions) {
      try {
        session.cleanup();
      } catch {
        // best-effort teardown of an already-broken session
      }
    }
    sessions.clear();
    for (const client of wsServer.clients) {
      try {
        client.close(1001, 'server shutting down');
      } catch {
        // ignore
      }
    }
    try {
      wsServer.close();
    } catch {
      // ignore
    }
  };

  return { stop };
}
