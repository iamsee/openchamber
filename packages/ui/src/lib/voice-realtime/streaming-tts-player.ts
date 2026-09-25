import { useConfigStore } from '@/stores/useConfigStore';
import { getRealtimeAudioContext } from './audio-context';

export interface StreamingTTSPlayer {
    enqueueText(chunk: string): Promise<void>;
    flush(): Promise<void>;
    clear(): void;
    onDrained(cb: () => void): () => void;
    isPlaying(): boolean;
}

const WAV_HEADER_BYTES = 44;

const parseWavPcm16 = (bytes: ArrayBuffer, ctx: AudioContext): AudioBuffer | null => {
    const view = new DataView(bytes);
    if (bytes.byteLength < WAV_HEADER_BYTES) return null;
    const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (riff !== 'RIFF') return null;
    let offset = 12;
    let sampleRate = 24000;
    let dataOffset = -1;
    let dataLength = 0;
    while (offset + 8 <= bytes.byteLength) {
        const id = String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
        const size = view.getUint32(offset + 4, true);
        if (id === 'fmt ') {
            sampleRate = view.getUint32(offset + 12, true);
        } else if (id === 'data') {
            dataOffset = offset + 8;
            dataLength = size;
            break;
        }
        offset += 8 + size;
    }
    if (dataOffset < 0) return null;
    const samples = Math.floor(dataLength / 2);
    const buffer = ctx.createBuffer(1, samples, sampleRate);
    const channel = buffer.getChannelData(0);
    const pcm = new DataView(bytes, dataOffset, dataLength);
    for (let i = 0; i < samples; i += 1) {
        channel[i] = pcm.getInt16(i * 2, true) / 32768;
    }
    return buffer;
};

export function createStreamingTTSPlayer(): StreamingTTSPlayer {
    const ctx = getRealtimeAudioContext();
    const masterGain = ctx.createGain();
    masterGain.gain.value = 1;
    masterGain.connect(ctx.destination);

    let epoch = 0;
    let pending = 0;
    let flushRequested = false;
    let scheduledEnd = 0;
    let chain: Promise<void> = Promise.resolve();
    const sources = new Set<AudioBufferSourceNode>();
    const drainedListeners = new Set<() => void>();

    const maybeDrained = () => {
        if (flushRequested && pending === 0 && sources.size === 0) {
            flushRequested = false;
            drainedListeners.forEach((cb) => cb());
        }
    };

    const synthesize = async (text: string, myEpoch: number): Promise<AudioBuffer | null> => {
        const cfg = useConfigStore.getState();
        const base = cfg.openaiCompatibleUrl?.trim();
        if (!base) return null;
        const body = {
            model: cfg.openaiCompatibleTtsModel,
            voice: cfg.openaiCompatibleVoice,
            input: text,
            response_format: 'wav',
        };
        const res = await fetch(`${base.replace(/\/$/, '')}/audio/speech`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...(cfg.openaiCompatibleApiKey ? { authorization: `Bearer ${cfg.openaiCompatibleApiKey}` } : {}),
            },
            body: JSON.stringify(body),
        });
        if (!res.ok || myEpoch !== epoch) return null;
        const bytes = await res.arrayBuffer();
        if (myEpoch !== epoch) return null;
        const wav = parseWavPcm16(bytes, ctx);
        if (wav) return wav;
        try {
            return await ctx.decodeAudioData(bytes);
        } catch {
            return null;
        }
    };

    const schedule = (audio: AudioBuffer, myEpoch: number) => {
        if (myEpoch !== epoch) return;
        masterGain.gain.setValueAtTime(1, ctx.currentTime);
        const src = ctx.createBufferSource();
        src.buffer = audio;
        src.connect(masterGain);
        const startAt = Math.max(ctx.currentTime, scheduledEnd);
        src.onended = () => {
            sources.delete(src);
            maybeDrained();
        };
        sources.add(src);
        src.start(startAt);
        scheduledEnd = startAt + audio.duration;
    };

    const enqueueText = (chunk: string): Promise<void> => {
        const text = chunk.trim();
        if (!text) return Promise.resolve();
        pending += 1;
        const myEpoch = epoch;
        chain = chain.then(async () => {
            try {
                const audio = await synthesize(text, myEpoch);
                if (audio && myEpoch === epoch) schedule(audio, myEpoch);
            } finally {
                pending -= 1;
                maybeDrained();
            }
        });
        return chain;
    };

    const flush = (): Promise<void> => {
        flushRequested = true;
        maybeDrained();
        return chain.then(() => {
            maybeDrained();
        });
    };

    const clear = () => {
        epoch += 1;
        pending = 0;
        flushRequested = false;
        chain = Promise.resolve();
        masterGain.gain.setTargetAtTime(0, ctx.currentTime, 0.005);
        sources.forEach((src) => {
            try {
                src.stop();
            } catch {
                // already stopped
            }
            src.disconnect();
        });
        sources.clear();
        scheduledEnd = ctx.currentTime;
    };

    const onDrained = (cb: () => void): (() => void) => {
        drainedListeners.add(cb);
        return () => {
            drainedListeners.delete(cb);
        };
    };

    const isPlaying = () => sources.size > 0 || scheduledEnd > ctx.currentTime;

    return { enqueueText, flush, clear, onDrained, isPlaying };
}
