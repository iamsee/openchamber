/**
 * useVoiceConversation — voice drives the CHAT, with streaming readback.
 *
 * Loop: mic -> server VAD/STT -> user_text -> insert+send to the chat's selected
 * model -> the assistant reply streams -> speakable sentences are synthesized and
 * played INCREMENTALLY (not after the whole reply) -> capture stays on so the next
 * utterance (or a barge-in over the readback) starts a new turn.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getSyncMessages, getSyncParts, getSyncSessionStatus } from '@/sync/sync-refs';
import { createRealtimeVoiceClient, type RealtimeVoiceClient, type ServerControl } from '@/lib/voice-realtime/realtime-voice-client';
import { startRealtimeCapture, type RealtimeCaptureHandle } from '@/lib/voice-realtime/audio-source';
import { getRealtimeAudioContext, unlockRealtimeAudio } from '@/lib/voice-realtime/audio-context';
import { createStreamingTTSPlayer, type StreamingTTSPlayer } from '@/lib/voice-realtime/streaming-tts-player';
import { createVoiceTimeline, type VoiceTimeline } from '@/lib/voice-realtime/voice-timeline';

export type VoiceConversationState = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface UseVoiceConversationOptions {
    onInsertAndSend: (text: string, opts?: { voiceMode?: boolean }) => void;
}

export interface UseVoiceConversationResult {
    active: boolean;
    state: VoiceConversationState;
    error: string | null;
    toggle: () => void;
    stop: () => void;
    subscribeLevel: (listener: (level: number) => void) => () => void;
}

const POLL_MS = 400;
const THINK_TIMEOUT_MS = 120_000;
/** Minimum transcript length accepted as a real barge-in over the readback (echo guard). */
const BARGE_MIN_CHARS = 2;

type SyncMessage = { id?: string; role?: string; info?: { role?: string } };

const messageRole = (m: SyncMessage): string => m.role ?? m.info?.role ?? '';

const messageText = (m: SyncMessage): string => {
    if (!m.id) return '';
    const parts = getSyncParts(m.id) as Array<{ type?: string; text?: string }>;
    return parts
        .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text as string)
        .join('');
};

const sessionIsBusy = (sessionId: string): boolean => {
    const status = getSyncSessionStatus(sessionId) as { type?: string; busy?: boolean } | undefined;
    if (!status) return false;
    return status.type === 'busy' || status.type === 'retry' || status.busy === true;
};

const lastAssistantMessage = (sessionId: string): SyncMessage | null => {
    const messages = getSyncMessages(sessionId) as SyncMessage[];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messageRole(messages[i]) === 'assistant') return messages[i];
    }
    return null;
};

export function useVoiceConversation(options: UseVoiceConversationOptions): UseVoiceConversationResult {
    const [state, setState] = useState<VoiceConversationState>('idle');
    const [error, setError] = useState<string | null>(null);
    const [active, setActive] = useState(false);

    const stateRef = useRef<VoiceConversationState>('idle');
    const activeRef = useRef(false);
    const clientRef = useRef<RealtimeVoiceClient | null>(null);
    const captureRef = useRef<RealtimeCaptureHandle | null>(null);
    const playerRef = useRef<StreamingTTSPlayer | null>(null);
    const timelineRef = useRef<VoiceTimeline | null>(null);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const seqRef = useRef(0);
    const spokenOffsetRef = useRef(0);
    const sawFirstTokenRef = useRef(false);
    const levelListenersRef = useRef<Set<(level: number) => void>>(new Set());

    const onInsertAndSendRef = useRef(options.onInsertAndSend);
    useEffect(() => {
        onInsertAndSendRef.current = options.onInsertAndSend;
    }, [options.onInsertAndSend]);

    const setStateBoth = useCallback((next: VoiceConversationState) => {
        stateRef.current = next;
        setState(next);
    }, []);

    const stopPoll = useCallback(() => {
        if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
        }
    }, []);

    const stopCapture = useCallback(() => {
        captureRef.current?.stop();
        captureRef.current = null;
    }, []);

    const subscribeLevel = useCallback((listener: (level: number) => void) => {
        levelListenersRef.current.add(listener);
        return () => {
            levelListenersRef.current.delete(listener);
        };
    }, []);

    const beginStreamingReadback = useCallback((sessionId: string) => {
        setStateBoth('thinking');
        stopPoll();
        spokenOffsetRef.current = 0;
        sawFirstTokenRef.current = false;
        const startedAt = Date.now();
        let sawBusy = false;
        pollRef.current = setInterval(() => {
            if (!activeRef.current) {
                stopPoll();
                return;
            }
            const player = playerRef.current;
            const timeline = timelineRef.current;
            const busy = sessionIsBusy(sessionId);
            if (busy) sawBusy = true;

            const assistant = lastAssistantMessage(sessionId);
            const fullText = assistant ? messageText(assistant) : '';
            if (fullText.length > spokenOffsetRef.current) {
                if (!sawFirstTokenRef.current) {
                    sawFirstTokenRef.current = true;
                    timeline?.mark('llm_first_token');
                    setStateBoth('speaking');
                }
                const boundary = /[。！？!?；;]+/g;
                let lastEnqueued = spokenOffsetRef.current;
                let m: RegExpExecArray | null;
                while ((m = boundary.exec(fullText)) !== null) {
                    const end = m.index + m[0].length;
                    if (end > spokenOffsetRef.current) {
                        const chunk = fullText.slice(lastEnqueued, end).trim();
                        if (chunk) {
                            void player?.enqueueText(chunk);
                            timeline?.mark('first_speakable_chunk');
                        }
                        lastEnqueued = end;
                    }
                }
                spokenOffsetRef.current = lastEnqueued;
            }

            const done = (sawBusy || sawFirstTokenRef.current) && !busy;
            const timedOut = Date.now() - startedAt > THINK_TIMEOUT_MS;
            if (done || timedOut) {
                stopPoll();
                const assistantFinal = lastAssistantMessage(sessionId);
                const finalText = assistantFinal ? messageText(assistantFinal) : '';
                const tail = finalText.slice(spokenOffsetRef.current).trim();
                if (tail) void player?.enqueueText(tail);
                void player?.flush();
            }
        }, POLL_MS);
    }, [setStateBoth, stopPoll]);

    const startListening = useCallback(async () => {
        if (!activeRef.current) return;
        setError(null);
        setStateBoth('listening');
        try {
            await unlockRealtimeAudio();
            const context = getRealtimeAudioContext();
            const client = createRealtimeVoiceClient();
            clientRef.current = client;
            const timeline = createVoiceTimeline();
            timelineRef.current = timeline;
            const player = createStreamingTTSPlayer();
            playerRef.current = player;

            client.onControl((message: ServerControl) => {
                if (!activeRef.current) return;
                if (message.type === 'user_text' && message.final && message.text.trim()) {
                    const text = message.text.trim();
                    const wasSpeaking = stateRef.current === 'speaking';
                    if (wasSpeaking && text.length >= BARGE_MIN_CHARS) {
                        playerRef.current?.clear();
                        timelineRef.current?.mark('interruption_detected');
                        timelineRef.current?.mark('playback_stopped');
                    }
                    timelineRef.current?.mark('vad_pause');
                    timelineRef.current?.mark('asr_final');
                    onInsertAndSendRef.current(text, { voiceMode: true });
                    timelineRef.current?.mark('turn_committed');
                    const sessionId = useSessionUIStore.getState().currentSessionId;
                    if (sessionId) beginStreamingReadback(sessionId);
                    else setStateBoth('thinking');
                } else if (message.type === 'error') {
                    setError(message.error);
                }
            });

            await client.connect();

            const settings = useConfigStore.getState();
            const language = settings.sttLanguage?.trim();
            client.sendControl({
                type: 'start',
                sessionId: `vc_${Date.now()}`,
                config: {
                    brain: 'assistant',
                    sttOnly: true,
                    provider: { url: '', model: '' },
                    stt: settings.sttProvider === 'openai-compatible'
                        ? {
                            url: settings.sttServerUrl,
                            model: settings.sttModel,
                            ...(settings.sttApiKey ? { apiKey: settings.sttApiKey } : {}),
                            ...(language ? { language } : {}),
                        }
                        : { url: '', model: '' },
                    tts: {
                        url: settings.openaiCompatibleUrl,
                        model: settings.openaiCompatibleTtsModel,
                        voice: settings.openaiCompatibleVoice,
                        ...(settings.openaiCompatibleApiKey ? { apiKey: settings.openaiCompatibleApiKey } : {}),
                    },
                },
            });

            const capture = await startRealtimeCapture({
                context,
                onFrame: (pcm16) => {
                    if (clientRef.current === client) client.sendAudio(pcm16, seqRef.current++);
                },
                onLevel: (level) => {
                    levelListenersRef.current.forEach((listener) => listener(level));
                },
            });
            captureRef.current = capture;
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            if (activeRef.current) {
                activeRef.current = false;
                setActive(false);
                setStateBoth('idle');
            }
        }
    }, [setStateBoth, beginStreamingReadback]);

    const stop = useCallback(() => {
        activeRef.current = false;
        setActive(false);
        stopPoll();
        playerRef.current?.clear();
        playerRef.current = null;
        stopCapture();
        clientRef.current?.close();
        clientRef.current = null;
        setStateBoth('idle');
    }, [stopPoll, stopCapture, setStateBoth]);

    const toggle = useCallback(() => {
        if (activeRef.current) {
            stop();
            return;
        }
        activeRef.current = true;
        setActive(true);
        void startListening();
    }, [stop, startListening]);

    useEffect(() => () => {
        activeRef.current = false;
        stopPoll();
        playerRef.current?.clear();
        stopCapture();
        clientRef.current?.close();
    }, [stopPoll, stopCapture]);

    return { active, state, error, toggle, stop, subscribeLevel };
}
