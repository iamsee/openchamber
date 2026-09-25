/**
 * Realtime voice conversation orchestration.
 *
 * Wires the audio layer (plan §10 contract: AudioWorklet capture, binary WS
 * client, gapless playback queue) into one conversation lifecycle. The server
 * owns turn detection and the IDLE/LISTENING/THINKING/SPEAKING state machine;
 * this hook owns the client half of the contract:
 *
 * - turnId gating: audio frames and transcripts from a superseded turn are
 *   dropped at the receive site, so a barge-in can never leak stale speech
 *   into the panel or the speakers (plan §4 rule 1);
 * - push-to-talk turns for devices whose echo calibration reports
 *   `fullDuplexSafe === false` — mic frames only flow while the talk button
 *   is held, and releasing seals the turn with `end_turn`;
 * - iOS suspended-context recovery: there are no UIBackgroundModes, so
 *   locking the phone suspends the AudioContext and it cannot resume without
 *   a gesture. On foreground return the hook surfaces SUSPENDED and the UI
 *   offers `resumeAudio()` instead of shipping a silently-dead session
 *   (plan §4 rule 5).
 *
 * The mic level is delivered by subscription, never through React state: it
 * updates at audio-callback rate, and routing it through state would re-render
 * the panel at the same rate — the exact mistake documented in the header of
 * `use-dictation-audio-source.ts`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
    getRealtimeAudioContext,
    isRealtimeAudioSuspended,
    unlockRealtimeAudio,
} from '@/lib/voice-realtime/audio-context';
import { createAudioQueue, type AudioQueue } from '@/lib/voice-realtime/audio-queue';
import {
    startRealtimeCapture,
    type RealtimeCaptureHandle,
} from '@/lib/voice-realtime/audio-source';
import type { EchoCalibrationResult } from '@/lib/voice-realtime/echo-calibration';
import {
    createRealtimeVoiceClient,
    VOICE_RUNTIME_CHANGED_REASON_CODE,
    VOICE_TRANSPORT_CLOSED_REASON_CODE,
    type ClientControl,
    type InboundAudioFrame,
    type RealtimeVoiceClient,
    type RealtimeVoiceConfig,
    type ServerControl,
} from '@/lib/voice-realtime/realtime-voice-client';
import { useConfigStore } from '@/stores/useConfigStore';

/** Server turn states plus the two client-only lifecycle states. */
export type RealtimeVoiceState =
    | 'IDLE'
    | 'CONNECTING'
    | 'LISTENING'
    | 'THINKING'
    | 'SPEAKING'
    | 'SUSPENDED'
    | 'ERROR';

export type RealtimeVoiceLevelListener = (rms: number) => void;

export interface RealtimeVoiceLevel {
    /** Subscribe to the normalized (0..1) mic level. Returns an unsubscribe. */
    subscribe(listener: RealtimeVoiceLevelListener): () => void;
}

export interface UseRealtimeVoiceResult {
    state: RealtimeVoiceState;
    /** True from a successful start() until stop(): drives panel visibility. */
    active: boolean;
    turnId: number | null;
    userText: string;
    assistantText: string;
    level: RealtimeVoiceLevel;
    calibration: EchoCalibrationResult | null;
    error: string | null;
    start: () => Promise<void>;
    stop: () => void;
    bargeIn: () => void;
    /** Push-to-talk press: forward mic frames again, cutting speech in progress. */
    beginTurn: () => void;
    /** Push-to-talk release: seal the turn so the brain can answer. */
    endTurn: () => void;
    /** Resume the suspended AudioContext; call inside a user gesture. */
    resumeAudio: () => Promise<boolean>;
}

const newSessionId = (): string => {
    const rand = Math.random().toString(36).slice(2, 10);
    return `vr_${Date.now().toString(16)}${rand}`;
};

/**
 * The realtime path reuses the existing voice settings (plan §6): STT comes
 * from the dictation provider, TTS from the OpenAI-compatible playback
 * provider. Both run server-side, so when the user has a non-server provider
 * configured the fields are sent empty and the server defaults (reported in
 * its `ready` frame) win.
 */
const buildConfig = (): RealtimeVoiceConfig => {
    const settings = useConfigStore.getState();
    const provider = settings.realtimeVoiceProvider;
    const language = settings.sttLanguage?.trim();
    const sttConfigured = settings.sttProvider === 'openai-compatible';
    const ttsConfigured = settings.openaiCompatibleUrl.trim().length > 0;
    return {
        brain: settings.realtimeVoiceBrain,
        provider: {
            url: provider.url,
            model: provider.model,
            ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
        },
        stt: {
            url: sttConfigured ? settings.sttServerUrl : '',
            model: sttConfigured ? settings.sttModel : '',
            ...(sttConfigured && settings.sttApiKey ? { apiKey: settings.sttApiKey } : {}),
            ...(language ? { language } : {}),
        },
        tts: {
            url: ttsConfigured ? settings.openaiCompatibleUrl : '',
            model: ttsConfigured ? settings.openaiCompatibleTtsModel : '',
            voice: settings.openaiCompatibleVoice,
            ...(ttsConfigured && settings.openaiCompatibleApiKey ? { apiKey: settings.openaiCompatibleApiKey } : {}),
        },
    };
};

export function useRealtimeVoice(): UseRealtimeVoiceResult {
    const [state, setState] = useState<RealtimeVoiceState>('IDLE');
    const [active, setActive] = useState(false);
    const [turnId, setTurnId] = useState<number | null>(null);
    const [userText, setUserText] = useState('');
    const [assistantText, setAssistantText] = useState('');
    const [calibration, setCalibration] = useState<EchoCalibrationResult | null>(null);
    const [error, setError] = useState<string | null>(null);

    const clientRef = useRef<RealtimeVoiceClient | null>(null);
    const queueRef = useRef<AudioQueue | null>(null);
    const captureRef = useRef<RealtimeCaptureHandle | null>(null);
    const unsubscribeRef = useRef<Array<() => void>>([]);
    const seqRef = useRef(0);
    const currentTurnIdRef = useRef<number | null>(null);
    const calibrationRef = useRef<EchoCalibrationResult | null>(null);
    const sessionLiveRef = useRef(false);
    const startingRef = useRef(false);
    const pttHeldRef = useRef(false);
    const suspendedRef = useRef(false);
    // Bumped by every teardown so an in-flight start() knows it was superseded
    // (stop() or unmount during the connect/capture awaits) and must not
    // repopulate the refs or the state.
    const generationRef = useRef(0);
    const lastServerStateRef = useRef<RealtimeVoiceState>('IDLE');
    const levelListenersRef = useRef<Set<RealtimeVoiceLevelListener>>(new Set());

    const level = useMemo<RealtimeVoiceLevel>(() => ({
        subscribe: (listener) => {
            levelListenersRef.current.add(listener);
            return () => {
                levelListenersRef.current.delete(listener);
            };
        },
    }), []);

    const teardown = useCallback(() => {
        generationRef.current += 1;
        sessionLiveRef.current = false;
        pttHeldRef.current = false;
        captureRef.current?.stop();
        captureRef.current = null;
        queueRef.current?.dispose();
        queueRef.current = null;
        for (const unsubscribe of unsubscribeRef.current) {
            unsubscribe();
        }
        unsubscribeRef.current = [];
        clientRef.current?.close();
        clientRef.current = null;
        currentTurnIdRef.current = null;
    }, []);

    const failSession = useCallback((err: unknown, message: string | null = null) => {
        if (!sessionLiveRef.current && !startingRef.current) {
            return;
        }
        teardown();
        suspendedRef.current = false;
        lastServerStateRef.current = 'IDLE';
        // The session stays `active` so the panel remains visible with the
        // error and its hang-up control; stop() is what dismisses it.
        setActive(true);
        setState('ERROR');
        const fallback = err instanceof Error ? err.message : String(err);
        setError(message ?? fallback);
    }, [teardown]);

    const sendControlSafely = useCallback((message: ClientControl) => {
        const client = clientRef.current;
        if (!client) {
            return;
        }
        try {
            client.sendControl(message);
        } catch (err) {
            failSession(err);
        }
    }, [failSession]);

    const handleControl = useCallback((message: ServerControl) => {
        switch (message.type) {
            case 'ready':
                return;
            case 'state': {
                if (currentTurnIdRef.current !== null && message.turnId !== currentTurnIdRef.current) {
                    setUserText('');
                    setAssistantText('');
                }
                currentTurnIdRef.current = message.turnId;
                setTurnId(message.turnId);
                lastServerStateRef.current = message.state;
                if (!suspendedRef.current) {
                    setState(message.state);
                }
                return;
            }
            case 'vad':
                return;
            case 'user_text': {
                if (currentTurnIdRef.current !== message.turnId) {
                    return;
                }
                setUserText(message.text);
                return;
            }
            case 'assistant_text': {
                if (currentTurnIdRef.current !== message.turnId) {
                    return;
                }
                setAssistantText(message.text);
                return;
            }
            case 'flush_audio': {
                queueRef.current?.flush(message.turnId);
                return;
            }
            case 'audio_end':
                return;
            case 'calibration': {
                const result: EchoCalibrationResult = {
                    echoPeak: message.echoPeak,
                    fullDuplexSafe: message.fullDuplexSafe,
                };
                calibrationRef.current = result;
                setCalibration(result);
                return;
            }
            case 'error': {
                // Transport loss and runtime switches are reported as
                // "retryable", but the client is terminal: it cannot reconnect.
                // The only recovery is a fresh session, so tear down and let
                // the user restart from the error panel.
                const transportLost = message.reasonCode === VOICE_TRANSPORT_CLOSED_REASON_CODE
                    || message.reasonCode === VOICE_RUNTIME_CHANGED_REASON_CODE;
                if (message.retryable && !transportLost) {
                    setError(message.error);
                    return;
                }
                failSession(null, message.error);
                return;
            }
            case 'pong':
                return;
        }
    }, [failSession]);

    const handleAudio = useCallback((frame: InboundAudioFrame) => {
        if (!sessionLiveRef.current) {
            return;
        }
        // Plan §4 rule 1: drop any frame whose turn is not the current one,
        // including frames still arriving after a flush_audio for that turn.
        if (currentTurnIdRef.current !== frame.turnId) {
            return;
        }
        queueRef.current?.enqueue(frame).catch((err: unknown) => {
            failSession(err);
        });
    }, [failSession]);

    const start = useCallback(async () => {
        if (startingRef.current || sessionLiveRef.current) {
            return;
        }
        startingRef.current = true;
        const generation = generationRef.current;
        setError(null);
        setCalibration(null);
        calibrationRef.current = null;
        currentTurnIdRef.current = null;
        setTurnId(null);
        setUserText('');
        setAssistantText('');
        seqRef.current = 0;
        pttHeldRef.current = false;
        suspendedRef.current = false;
        lastServerStateRef.current = 'IDLE';
        setState('CONNECTING');

        let client: RealtimeVoiceClient | null = null;
        let queue: AudioQueue | null = null;
        let capture: RealtimeCaptureHandle | null = null;
        try {
            // Must run inside the user gesture that pressed the voice button;
            // iOS keeps the context suspended otherwise.
            const unlocked = await unlockRealtimeAudio();
            if (generationRef.current !== generation) {
                return;
            }
            if (!unlocked) {
                throw new Error('Audio could not be unlocked. Tap the voice button again.');
            }
            const context = getRealtimeAudioContext();

            client = createRealtimeVoiceClient();
            unsubscribeRef.current = [client.onControl(handleControl), client.onAudio(handleAudio)];
            clientRef.current = client;
            await client.connect();
            if (generationRef.current !== generation) {
                return;
            }

            queue = createAudioQueue(context);
            queueRef.current = queue;

            capture = await startRealtimeCapture({
                context,
                onFrame: (pcm16) => {
                    if (!sessionLiveRef.current) {
                        return;
                    }
                    // Half-duplex PTT (echo-unsafe devices): mic frames only
                    // flow while the talk button is held, so the assistant's
                    // own voice never reaches the server VAD.
                    if (calibrationRef.current?.fullDuplexSafe === false && !pttHeldRef.current) {
                        return;
                    }
                    try {
                        client?.sendAudio(pcm16, seqRef.current);
                        seqRef.current += 1;
                    } catch (err) {
                        // A socket that died mid-session must not throw inside
                        // the audio callback; surface it and tear down.
                        failSession(err);
                    }
                },
                onLevel: (rms) => {
                    for (const listener of levelListenersRef.current) {
                        listener(rms);
                    }
                },
            });
            if (generationRef.current !== generation) {
                capture.stop();
                return;
            }
            captureRef.current = capture;

            sessionLiveRef.current = true;
            setActive(true);
            client.sendControl({ type: 'start', sessionId: newSessionId(), config: buildConfig() });
            // The server's first `state` frame moves us to LISTENING; until it
            // arrives the conversation is connected but quiet (IDLE).
            setState('IDLE');
        } catch (err) {
            if (generationRef.current === generation) {
                capture?.stop();
                queue?.dispose();
                client?.close();
                unsubscribeRef.current = [];
                clientRef.current = null;
                queueRef.current = null;
                setActive(true);
                setState('ERROR');
                setError(err instanceof Error ? err.message : String(err));
            }
        } finally {
            startingRef.current = false;
        }
    }, [failSession, handleAudio, handleControl]);

    const stop = useCallback(() => {
        teardown();
        suspendedRef.current = false;
        lastServerStateRef.current = 'IDLE';
        setActive(false);
        setState('IDLE');
        setTurnId(null);
        setUserText('');
        setAssistantText('');
        setError(null);
        setCalibration(null);
        calibrationRef.current = null;
    }, [teardown]);

    const bargeIn = useCallback(() => {
        if (!sessionLiveRef.current) {
            return;
        }
        // Immediate local silence (the queue ramps its master gain, no click);
        // the server follows with flush_audio and the new turn's state.
        const current = currentTurnIdRef.current;
        if (current !== null) {
            queueRef.current?.flush(current);
        }
        sendControlSafely({ type: 'barge_in' });
    }, [sendControlSafely]);

    const beginTurn = useCallback(() => {
        if (!sessionLiveRef.current || pttHeldRef.current) {
            return;
        }
        pttHeldRef.current = true;
        // Pressing talk over the assistant's voice is an explicit interrupt —
        // the only kind push-to-talk mode allows.
        if (lastServerStateRef.current === 'SPEAKING' || lastServerStateRef.current === 'THINKING') {
            bargeIn();
        }
    }, [bargeIn]);

    const endTurn = useCallback(() => {
        if (!sessionLiveRef.current || !pttHeldRef.current) {
            return;
        }
        pttHeldRef.current = false;
        sendControlSafely({ type: 'end_turn' });
    }, [sendControlSafely]);

    const resumeAudio = useCallback(async (): Promise<boolean> => {
        const resumed = await unlockRealtimeAudio();
        if (resumed && suspendedRef.current) {
            suspendedRef.current = false;
            if (sessionLiveRef.current) {
                setState(lastServerStateRef.current);
            }
        }
        return resumed;
    }, []);

    // iOS suspends the AudioContext when the page backgrounds or the phone
    // locks, and only a user gesture can resume it (plan §4 rule 5). Check on
    // every foreground return so the panel can offer the resume affordance.
    useEffect(() => {
        if (!active) {
            return;
        }
        const checkSuspended = () => {
            if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
                return;
            }
            if (!sessionLiveRef.current || suspendedRef.current) {
                return;
            }
            if (isRealtimeAudioSuspended()) {
                suspendedRef.current = true;
                setState('SUSPENDED');
            }
        };
        document.addEventListener('visibilitychange', checkSuspended);
        window.addEventListener('focus', checkSuspended);
        return () => {
            document.removeEventListener('visibilitychange', checkSuspended);
            window.removeEventListener('focus', checkSuspended);
        };
    }, [active]);

    useEffect(() => teardown, [teardown]);

    return {
        state,
        active,
        turnId,
        userText,
        assistantText,
        level,
        calibration,
        error,
        start,
        stop,
        bargeIn,
        beginTurn,
        endTurn,
        resumeAudio,
    };
}
