import React from 'react';

import { DictationWaveform } from '@/components/dictation/DictationWaveform';
import { Icon } from '@/components/icon/Icon';
import type { UseVoiceConversationResult } from '@/hooks/useVoiceConversation';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const STATE_COLOR: Record<string, string> = {
    listening: 'var(--status-success)',
    thinking: 'var(--status-warning)',
    speaking: 'var(--status-info)',
    idle: 'var(--status-neutral)',
};

interface VoiceConversationBarProps {
    voice: Pick<UseVoiceConversationResult, 'active' | 'state' | 'stop' | 'subscribeLevel'>;
    className?: string;
}

export const VoiceConversationBar: React.FC<VoiceConversationBarProps> = ({ voice, className }) => {
    const { t } = useI18n();
    if (!voice.active) return null;
    const color = STATE_COLOR[voice.state] ?? STATE_COLOR.idle;
    return (
        <div
            className={cn('flex items-center gap-2 rounded-md border bg-muted/40 px-2 py-1', className)}
            aria-label={t('chat.voice.panelAria')}
        >
            <span className="relative flex h-2 w-2 flex-shrink-0" aria-hidden="true">
                <span className="relative inline-flex h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
            </span>
            <DictationWaveform subscribeLevel={voice.subscribeLevel} className="block h-4 min-w-0 flex-1" />
            <span className="typography-meta flex-shrink-0" style={{ color }}>
                {t(`chat.voice.state.${voice.state}`)}
            </span>
            <button
                type="button"
                onClick={voice.stop}
                title={t('chat.voice.stop')}
                aria-label={t('chat.voice.stop')}
                className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            >
                <Icon name="stop" className="h-4 w-4" />
            </button>
        </div>
    );
};
