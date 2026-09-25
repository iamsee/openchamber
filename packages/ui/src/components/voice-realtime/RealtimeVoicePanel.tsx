/**
 * In-place subtitle panel for the realtime voice conversation. Mounted above
 * the composer — deliberately not a global floating orb and not a separate
 * route: the conversation stays beside the chat it can hand off to.
 *
 * Shows the turn state pill, a live mic level meter, both transcripts (the
 * assistant's streaming in), an interrupt control and hang-up. The level
 * meter is the subscription-driven DictationWaveform canvas: audio-rate
 * updates never pass through React state (see the header of
 * `use-dictation-audio-source.ts` for the re-render cost of doing it wrong).
 *
 * When the startup echo calibration reports `fullDuplexSafe === false`
 * (devices with no usable AEC — assume every iOS WKWebView), the interrupt
 * control is replaced by push-to-talk so the assistant's own voice cannot
 * self-interrupt through the speaker echo.
 *
 * When iOS suspends the AudioContext (backgrounding/locking the phone), the
 * panel turns into a tap-to-resume affordance: the context can only be
 * resumed inside a user gesture.
 */

import React from 'react';

import { DictationWaveform } from '@/components/dictation/DictationWaveform';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import type { UseRealtimeVoiceResult } from '@/hooks/useRealtimeVoice';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface RealtimeVoicePanelProps {
    voice: UseRealtimeVoiceResult;
    className?: string;
}

export const RealtimeVoicePanel: React.FC<RealtimeVoicePanelProps> = ({ voice, className }) => {
    const { t } = useI18n();
    const { currentTheme } = useThemeSystem();
    const { state, active, userText, assistantText, calibration, error } = voice;
    const transcriptsRef = React.useRef<HTMLDivElement | null>(null);
    const [pttHeld, setPttHeld] = React.useState(false);

    // Follow the newest words like a caret while the subtitles scroll.
    React.useLayoutEffect(() => {
        const area = transcriptsRef.current;
        if (area) {
            area.scrollTop = area.scrollHeight;
        }
    }, [userText, assistantText, state]);

    if (!active) {
        return null;
    }

    const pushToTalk = calibration !== null && !calibration.fullDuplexSafe;
    const colors = currentTheme.colors;
    const pill: { label: string; color: string; spinner: boolean } = (() => {
        switch (state) {
            case 'CONNECTING':
                return { label: t('chat.voice.state.connecting'), color: colors.surface.mutedForeground, spinner: true };
            case 'LISTENING':
                return { label: t('chat.voice.state.listening'), color: colors.status.error, spinner: false };
            case 'THINKING':
                return { label: t('chat.voice.state.thinking'), color: colors.status.warning, spinner: true };
            case 'SPEAKING':
                return { label: t('chat.voice.state.speaking'), color: colors.primary.base, spinner: false };
            case 'SUSPENDED':
                return { label: t('chat.voice.state.suspended'), color: colors.status.warning, spinner: false };
            case 'ERROR':
                return { label: t('chat.voice.state.error'), color: colors.status.error, spinner: false };
            case 'IDLE':
            default:
                return { label: t('chat.voice.state.idle'), color: colors.surface.mutedForeground, spinner: false };
        }
    })();

    // Tapping panel controls must not dismiss the soft keyboard (same
    // keepKeyboardFocusProps pattern as ComposerDictation).
    const keepKeyboardFocusProps = {
        onMouseDown: (event: React.MouseEvent) => event.preventDefault(),
        onPointerDownCapture: (event: React.PointerEvent) => {
            if (event.pointerType === 'touch') {
                event.preventDefault();
            }
        },
    } as const;

    const showInterrupt = !pushToTalk && (state === 'SPEAKING' || state === 'THINKING');

    return (
        <section
            aria-label={t('chat.voice.panelAria')}
            className={cn(
                'oc-glass-composer relative overflow-hidden rounded-xl border border-border/80 px-3 py-2',
                'shadow-[0_4px_16px_-4px_rgb(0_0_0_/_0.12)]',
                className,
            )}
        >
            <div className="flex items-center gap-2">
                <span className="flex flex-shrink-0 items-center gap-1.5" role="status">
                    {pill.spinner ? (
                        <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin" style={{ color: pill.color }} />
                    ) : (
                        <span className="relative flex h-2 w-2" aria-hidden="true">
                            {state === 'LISTENING' ? (
                                <span
                                    className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
                                    style={{ backgroundColor: pill.color }}
                                />
                            ) : null}
                            <span
                                className="relative inline-flex h-2 w-2 rounded-full"
                                style={{ backgroundColor: pill.color }}
                            />
                        </span>
                    )}
                    <span className="typography-meta flex-shrink-0" style={{ color: pill.color }}>
                        {pill.label}
                    </span>
                </span>
                <DictationWaveform subscribeLevel={voice.level.subscribe} className="block h-4 min-w-0 flex-1" />
                <div className="ml-auto flex flex-shrink-0 items-center gap-x-1.5">
                    {showInterrupt ? (
                        <Button
                            variant="ghost"
                            size="xs"
                            className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                            {...keepKeyboardFocusProps}
                            onClick={voice.bargeIn}
                            title={t('chat.voice.interrupt')}
                            aria-label={t('chat.voice.interrupt')}
                        >
                            <Icon name="stop" className="h-4 w-4" />
                        </Button>
                    ) : null}
                    <Button
                        variant="ghost"
                        size="xs"
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-[var(--status-error)]"
                        {...keepKeyboardFocusProps}
                        onClick={voice.stop}
                        title={t('chat.voice.stop')}
                        aria-label={t('chat.voice.stop')}
                    >
                        <Icon name="close" className="h-4 w-4" />
                    </Button>
                </div>
            </div>

            <div ref={transcriptsRef} aria-live="polite" className="mt-1.5 max-h-24 space-y-1 overflow-y-auto">
                {userText ? (
                    <p className="typography-ui-label">
                        <span className="typography-meta mr-1.5 text-muted-foreground">{t('chat.voice.you')}</span>
                        <span className="text-foreground">{userText}</span>
                    </p>
                ) : null}
                <p className="typography-ui-label">
                    <span className="typography-meta mr-1.5 text-muted-foreground">{t('chat.voice.assistant')}</span>
                    <span className={assistantText ? 'text-foreground' : 'text-muted-foreground'}>
                        {assistantText || t('chat.voice.placeholder')}
                    </span>
                </p>
                {error ? (
                    <p className="typography-meta" style={{ color: colors.status.error }}>
                        {error}
                    </p>
                ) : null}
            </div>

            {pushToTalk ? (
                <div className="mt-2 space-y-1">
                    <button
                        type="button"
                        {...keepKeyboardFocusProps}
                        className={cn(
                            'flex h-9 w-full touch-none select-none items-center justify-center gap-1.5 rounded-lg border',
                            'typography-ui-label transition-none',
                            pttHeld
                                ? 'border-interactive-border-focus bg-interactive-selection text-interactive-selection-foreground'
                                : 'border-input bg-surface-elevated text-foreground',
                        )}
                        onPointerDown={() => {
                            setPttHeld(true);
                            voice.beginTurn();
                        }}
                        onPointerUp={() => {
                            setPttHeld(false);
                            voice.endTurn();
                        }}
                        onPointerCancel={() => {
                            setPttHeld(false);
                            voice.endTurn();
                        }}
                        onPointerLeave={() => {
                            if (!pttHeld) {
                                return;
                            }
                            setPttHeld(false);
                            voice.endTurn();
                        }}
                    >
                        <Icon name="mic" className="h-4 w-4" />
                        {t('chat.voice.ptt.hold')}
                    </button>
                    <p className="typography-meta text-center text-muted-foreground">
                        {t('chat.voice.ptt.hint')}
                    </p>
                </div>
            ) : null}

            {state === 'SUSPENDED' ? (
                <button
                    type="button"
                    {...keepKeyboardFocusProps}
                    className="absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-xl bg-background/75"
                    onClick={() => {
                        void voice.resumeAudio();
                    }}
                >
                    <Icon name="play" className="h-4 w-4 text-foreground" />
                    <span className="typography-ui-label text-foreground">{t('chat.voice.resume')}</span>
                </button>
            ) : null}
        </section>
    );
};
