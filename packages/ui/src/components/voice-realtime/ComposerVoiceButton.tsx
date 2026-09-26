/**
 * Composer-footer trigger for the voice conversation loop. Sits beside the
 * dictation mic. One tap starts the loop (voice -> composer -> send -> the
 * chat's selected model -> readback); a second tap stops it. A waveform bar
 * (VoiceConversationBar) shows live mic level while listening.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { UseVoiceConversationResult } from '@/hooks/useVoiceConversation';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { isRealtimeCaptureSupported } from '@/lib/voice-realtime/audio-source';
import { useConfigStore } from '@/stores/useConfigStore';

interface ComposerVoiceButtonProps {
    voice: Pick<UseVoiceConversationResult, 'state' | 'active' | 'toggle'>;
    footerIconButtonClass: string;
    iconSizeClass: string;
    disabled?: boolean;
}

export const ComposerVoiceButton: React.FC<ComposerVoiceButtonProps> = ({
    voice,
    footerIconButtonClass,
    iconSizeClass,
    disabled,
}) => {
    const { t } = useI18n();
    const realtimeVoiceEnabled = useConfigStore((state) => state.realtimeVoiceEnabled);
    // The realtime voice server (WebSocket + STT/LLM/TTS pipeline) lives in
    // the OpenChamber web server; the VS Code bridge has no server process
    // for it (same constraint as the dictation mic).
    const [supported] = React.useState(() => !isVSCodeRuntime() && isRealtimeCaptureSupported());

    if (!supported || !realtimeVoiceEnabled) {
        return null;
    }

    const { state, active } = voice;
    const sessionLive = active && state !== 'idle';

    // Voice must not dismiss the soft keyboard: block the focus transfer iOS
    // performs on tap (same keepKeyboardFocusProps pattern as
    // ComposerDictation / PermissionAutoAcceptButton).
    const keepKeyboardFocusProps = {
        onMouseDown: (event: React.MouseEvent) => event.preventDefault(),
        onPointerDownCapture: (event: React.PointerEvent) => {
            if (event.pointerType === 'touch') {
                event.preventDefault();
            }
        },
    } as const;

    return (
        <button
            type="button"
            {...keepKeyboardFocusProps}
            className={cn(footerIconButtonClass, sessionLive && 'text-primary hover:text-primary')}
            onClick={() => {
                // toggle() starts (unlockRealtimeAudio runs inside this gesture,
                // which iOS requires to unsuspend audio) or stops the loop.
                voice.toggle();
            }}
            disabled={disabled}
            title={sessionLive ? t('chat.voice.stop') : t('chat.voice.start')}
            aria-label={sessionLive ? t('chat.voice.stop') : t('chat.voice.start')}
            aria-pressed={sessionLive}
        >
            <Icon name={sessionLive ? 'mic' : 'phone'} className={cn(iconSizeClass, 'text-current')} />
        </button>
    );
};
