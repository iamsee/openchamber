/**
 * useVoiceConversation — voice drives the CHAT, with streaming readback.
 *
 * Loop: mic -> server VAD/STT -> user_text -> insert+send to the chat's selected
 * model -> the assistant reply streams -> speakable sentences are synthesized and
 * played INCREMENTALLY (not after the whole reply) -> capture stays on so the next
 * utterance (or a barge-in over the readback) starts a new turn.
 *
 * The session resources (WebSocket, mic capture, TTS player, readback poll) live
 * in a module-level engine, NOT in React state held by this hook. The first voice
 * turn typically creates the chat session, which routes to `/?session=…` and
 * remounts the whole composer subtree — a per-component engine died right there
 * (mic + socket torn down mid-turn, readback never started). The hook is a thin
 * subscriber: unmounting it only unsubscribes the UI; `stop()` is the one path
 * that tears the engine down.
 *
 * Readback baseline: the poll remembers the assistant message that existed when
 * the turn was committed and only speaks messages newer than that. Without the
 * baseline, the first poll tick read the PREVIOUS turn's reply — which was then
 * spoken in full (stale answer, not streaming) while the real reply never got a
 * single sentence queued.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getSyncMessages, getSyncParts, getSyncSessionStatus } from '@/sync/sync-refs';
import { createRealtimeVoiceClient, type RealtimeVoiceClient, type ServerControl } from '@/lib/voice-realtime/realtime-voice-client';
import { startRealtimeCapture, type RealtimeCaptureHandle } from '@/lib/voice-realtime/audio-source';
import { getRealtimeAudioContext, isRealtimeAudioSuspended, unlockRealtimeAudio } from '@/lib/voice-realtime/audio-context';
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
/**
 * Readback waits this long for the model's busy status before trusting a
 * not-busy reading. The first ticks after send often arrive before the status
 * event lands, and without this grace the poll would end on "never saw busy".
 */
const BUSY_GRACE_MS = 1500;
/** Leading marker lines (e.g. `**【For OliverZ】**`) are UI decoration, not speech. */
const SPOKEN_TEXT_STRIP_RE = /^\s*(\*\*【[^】]*】\*\*\s*)+/;

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

const spokenText = (text: string): string => text.replace(SPOKEN_TEXT_STRIP_RE, '');

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

// ---------------------------------------------------------------------------
// Module-level engine: one voice conversation per page, owned here.
// ---------------------------------------------------------------------------

interface VoiceEngineSnapshot {
    active: boolean;
    state: VoiceConversationState;
    error: string | null;
}

const engineListeners = new Set<() => void>();
let engineSnapshot: VoiceEngineSnapshot = { active: false, state: 'idle', error: null };

const engine = (() => {
    let started = false;
    let state: VoiceConversationState = 'idle';
    let client: RealtimeVoiceClient | null = null;
    let capture: RealtimeCaptureHandle | null = null;
    let player: StreamingTTSPlayer | null = null;
    let timeline: VoiceTimeline | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let watchdog: ReturnType<typeof setInterval> | null = null;
    let seq = 0;
    let spokenOffset = 0;
    /** Assistant message id that existed when the current turn was committed. */
    let baselineMessageId: string | null | undefined;
    let sawFirstToken = false;
    /** Set when a turn committed before a session id existed; the store watcher starts the readback. */
    let pendingReadback = false;
    const levelListeners = new Set<(level: number) => void>();
    let insertAndSend: ((text: string, opts?: { voiceMode?: boolean }) => void) | null = null;
    let lastFrameAt = 0;

    const publish = (patch: Partial<VoiceEngineSnapshot>): void => {
        engineSnapshot = { ...engineSnapshot, ...patch };
        for (const listener of engineListeners) listener();
    };

    const setState = (next: VoiceConversationState): void => {
        state = next;
        publish({ state: next });
    };

    const setError = (message: string | null): void => {
        publish({ error: message });
    };

    const stopPoll = (): void => {
        if (poll) {
            clearInterval(poll);
            poll = null;
        }
    };

    /** A turn was committed into a session that did not exist yet (the composer creates it asynchronously). */
    const armPendingReadback = (): void => {
        pendingReadback = true;
        const existing = useSessionUIStore.getState().currentSessionId;
        if (existing) {
            pendingReadback = false;
            beginStreamingReadback(existing);
        }
    };

    const stopWatchdog = (): void => {
        if (watchdog) {
            clearInterval(watchdog);
            watchdog = null;
        }
    };

    const stopCapture = (): void => {
        capture?.stop();
        capture = null;
    };

    const beginStreamingReadback = (sessionId: string): void => {
        setState('thinking');
        stopPoll();
        // Baseline: only messages committed AFTER this point are this turn's
        // reply. The previous turn's answer may still be the latest assistant
        // message for the first ticks — speaking it is the stale-answer bug.
        baselineMessageId = lastAssistantMessage(sessionId)?.id ?? null;
        spokenOffset = 0;
        sawFirstToken = false;
        const startedAt = Date.now();
        const busyGraceUntil = Date.now() + BUSY_GRACE_MS;
        let sawBusy = false;
        poll = setInterval(() => {
            if (!engineSnapshot.active) {
                stopPoll();
                return;
            }
            const activePlayer = player;
            const activeTimeline = timeline;
            const busy = sessionIsBusy(sessionId);
            if (busy) sawBusy = true;

            const assistant = lastAssistantMessage(sessionId);
            const isThisTurnReply = !!assistant?.id && assistant.id !== baselineMessageId;
            const fullText = isThisTurnReply && assistant ? spokenText(messageText(assistant)) : '';
            if (fullText.length > spokenOffset) {
                if (!sawFirstToken) {
                    sawFirstToken = true;
                    activeTimeline?.mark('llm_first_token');
                    setState('speaking');
                }
                const boundary = /[。！？!?；;]+/g;
                let lastEnqueued = spokenOffset;
                let m: RegExpExecArray | null;
                while ((m = boundary.exec(fullText)) !== null) {
                    const end = m.index + m[0].length;
                    if (end > spokenOffset) {
                        const chunk = fullText.slice(lastEnqueued, end).trim();
                        if (chunk) {
                            void activePlayer?.enqueueText(chunk);
                            activeTimeline?.mark('first_speakable_chunk');
                        }
                        lastEnqueued = end;
                    }
                }
                spokenOffset = lastEnqueued;
            }

            const graceElapsed = Date.now() >= busyGraceUntil;
            const done = (sawBusy || sawFirstToken) && !busy && graceElapsed;
            const timedOut = Date.now() - startedAt > THINK_TIMEOUT_MS;
            if (done || timedOut) {
                stopPoll();
                const finalAssistant = lastAssistantMessage(sessionId);
                const finalText = finalAssistant && finalAssistant.id !== baselineMessageId ? spokenText(messageText(finalAssistant)) : '';
                const tail = finalText.slice(spokenOffset).trim();
                if (tail) void activePlayer?.enqueueText(tail);
                void activePlayer?.flush();
            }
        }, POLL_MS);
    };

    const teardown = (): void => {
        stopPoll();
        stopWatchdog();
        player?.clear();
        player = null;
        stopCapture();
        client?.close();
        client = null;
    };

    const startListening = async (): Promise<void> => {
        if (started || !engineSnapshot.active) return;
        started = true;
        setError(null);
        setState('listening');
        try {
            const unlocked = await unlockRealtimeAudio();
            if (!unlocked) {
                // The browser refused to start audio (autoplay policy outside a
                // real gesture, or iOS after backgrounding). Surfacing this is
                // the difference between one dead-looking session and a user
                // who knows to tap again — the next tap re-runs the unlock.
                throw new Error('浏览器音频未解锁：请再点一次麦克风');
            }
            const context = getRealtimeAudioContext();

            client = createRealtimeVoiceClient();
            timeline = createVoiceTimeline();
            player = createStreamingTTSPlayer();
            const activeClient = client;

            client.onControl((message: ServerControl) => {
                if (!engineSnapshot.active) return;
                if (message.type === 'user_text' && message.final && message.text.trim()) {
                    const text = message.text.trim();
                    const wasSpeaking = state === 'speaking';
                    if (wasSpeaking && text.length >= BARGE_MIN_CHARS) {
                        player?.clear();
                        timeline?.mark('interruption_detected');
                        timeline?.mark('playback_stopped');
                    }
                    timeline?.mark('vad_pause');
                    timeline?.mark('asr_final');
                    insertAndSend?.(text, { voiceMode: true });
                    timeline?.mark('turn_committed');
                    // The composer may create a new session for this turn and
                    // remount the tree that owns us — read the CURRENT session
                    // id from the store instead of holding a stale one. When no
                    // session exists yet (first turn of a new chat), arm the
                    // watcher instead of dropping the readback on the floor.
                    const sessionId = useSessionUIStore.getState().currentSessionId;
                    if (sessionId) beginStreamingReadback(sessionId);
                    else armPendingReadback();
                } else if (message.type === 'error') {
                    setError(message.error);
                }
            });

            await activeClient.connect();

            const settings = useConfigStore.getState();
            const language = settings.sttLanguage?.trim();
            activeClient.sendControl({
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

            capture = await startRealtimeCapture({
                context,
                onFrame: (pcm16) => {
                    lastFrameAt = Date.now();
                    if (client === activeClient) activeClient.sendAudio(pcm16, seq++);
                },
                onLevel: (level) => {
                    levelListeners.forEach((listener) => listener(level));
                },
            });

            // Capture stall watchdog. A healthy mic graph emits a frame every
            // 100 ms — silence included — so any gap means the browser suspended
            // the shared AudioContext (autoplay policy after a reload, iOS
            // backgrounding, a lost device). Without this check the session sits
            // in "listening" with a dead mic and the only symptom is that
            // nothing ever gets transcribed.
            lastFrameAt = Date.now();
            const stallStartedAt = { value: 0 };
            stopWatchdog();
            watchdog = setInterval(() => {
                if (!engineSnapshot.active) {
                    stopWatchdog();
                    return;
                }
                const silentFor = Date.now() - lastFrameAt;
                if (silentFor < 2500) {
                    stallStartedAt.value = 0;
                    return;
                }
                // First sign of trouble: try to resume the shared context — the
                // original tap's activation may still be fresh enough.
                getRealtimeAudioContext().resume().catch(() => undefined);
                if (stallStartedAt.value === 0) {
                    stallStartedAt.value = Date.now();
                    return;
                }
                if (state === 'listening' && Date.now() - stallStartedAt.value > 3000) {
                    setError('麦克风无音频输入（浏览器暂停了音频）：请再点一次麦克风');
                    stop();
                }
            }, 1000);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            stopWatchdog();
            if (engineSnapshot.active) {
                publish({ active: false });
                teardown();
                setState('idle');
            }
        } finally {
            started = false;
        }
    };

    const stop = (): void => {
        publish({ active: false });
        pendingReadback = false;
        teardown();
        setState('idle');
    };

    const toggle = (): void => {
        if (engineSnapshot.active) {
            stop();
            return;
        }
        publish({ active: true, error: null });
        void startListening();
    };

    // The first turn of a new chat commits before the composer has created the
    // session; this watcher bridges that gap so the readback still starts.
    useSessionUIStore.subscribe((storeState) => {
        if (!pendingReadback) return;
        const sessionId = storeState.currentSessionId;
        if (sessionId) {
            pendingReadback = false;
            beginStreamingReadback(sessionId);
        }
    });

    // Returning to the page after backgrounding: iOS leaves the shared context
    // suspended, and desktop Chrome can too. Resuming here needs no new gesture
    // on desktop; on iOS the watchdog + a re-tap covers the rest.
    if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible') return;
            if (!engineSnapshot.active) return;
            if (isRealtimeAudioSuspended()) {
                getRealtimeAudioContext().resume().catch(() => undefined);
            }
        });
    }
    if (typeof window !== 'undefined') {
        window.addEventListener('beforeunload', () => {
            teardown();
        });
    }

    return {
        subscribe(listener: () => void): () => void {
            engineListeners.add(listener);
            return () => {
                engineListeners.delete(listener);
            };
        },
        getSnapshot: (): VoiceEngineSnapshot => engineSnapshot,
        setInsertAndSend(cb: (text: string, opts?: { voiceMode?: boolean }) => void): void {
            insertAndSend = cb;
        },
        toggle,
        stop,
        subscribeLevel(listener: (level: number) => void): () => void {
            levelListeners.add(listener);
            return () => {
                levelListeners.delete(listener);
            };
        },
    };
})();

// ---------------------------------------------------------------------------
// React subscriber hook.
// ---------------------------------------------------------------------------

export function useVoiceConversation(options: UseVoiceConversationOptions): UseVoiceConversationResult {
    const [snapshot, setSnapshot] = useState<VoiceEngineSnapshot>(engine.getSnapshot());

    useEffect(() => engine.subscribe(() => setSnapshot(engine.getSnapshot())), []);

    // Keep the engine's send callback pointed at the composer's LATEST handler:
    // remounts swap the closure, and a stale one would insert text into an
    // unmounted composer.
    const onInsertAndSendRef = useRef(options.onInsertAndSend);
    useEffect(() => {
        onInsertAndSendRef.current = options.onInsertAndSend;
    }, [options.onInsertAndSend]);
    useEffect(() => {
        engine.setInsertAndSend((text, opts) => onInsertAndSendRef.current(text, opts));
    }, []);

    const subscribeLevel = useCallback((listener: (level: number) => void) => engine.subscribeLevel(listener), []);

    // No unmount teardown here — that is the whole point of the engine. The
    // first voice turn creates the session and remounts this subtree; killing
    // the mic then was the "first turn always dies" bug.

    return { active: snapshot.active, state: snapshot.state, error: snapshot.error, toggle: engine.toggle, stop: engine.stop, subscribeLevel };
}
