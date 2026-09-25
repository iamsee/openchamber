/**
 * Per-turn perceived-latency timeline for realtime voice: instruments the
 * user_last_audio -> client_first_audible path so we optimize time-to-speaker,
 * not API latency.
 */

export type VoiceTimelineMark =
  | 'user_last_audio'
  | 'vad_pause'
  | 'asr_final'
  | 'turn_committed'
  | 'llm_first_token'
  | 'first_speakable_chunk'
  | 'tts_first_audio'
  | 'client_first_audible'
  | 'interruption_detected'
  | 'playback_stopped';

export interface VoiceTimelineEntry {
  name: VoiceTimelineMark;
  tMs: number;
  extra?: Record<string, unknown>;
}

export interface VoiceTimeline {
  mark(name: VoiceTimelineMark, extra?: Record<string, unknown>): void;
  /** ms since turn start (first mark after reset) for each recorded mark, in insertion order. */
  snapshot(): VoiceTimelineEntry[];
  /**
   * Computed key gaps (ms, rounded): endpointWait (asr_final - user_last_audio),
   * sendToFirstToken (llm_first_token - turn_committed), firstTokenToAudible
   * (client_first_audible - llm_first_token), total (user_last_audio ->
   * client_first_audible). Only includes gaps whose both endpoints exist.
   */
  gaps(): Record<string, number>;
  reset(): void;
  /** Log snapshot+gaps to console (dev aid). */
  dump(): void;
}

const TIMELINE_GAPS: ReadonlyArray<{
  name: string;
  from: VoiceTimelineMark;
  to: VoiceTimelineMark;
}> = [
  { name: 'endpointWait', from: 'user_last_audio', to: 'asr_final' },
  { name: 'sendToFirstToken', from: 'turn_committed', to: 'llm_first_token' },
  { name: 'firstTokenToAudible', from: 'llm_first_token', to: 'client_first_audible' },
  { name: 'total', from: 'user_last_audio', to: 'client_first_audible' },
];

const nowMs = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

export function createVoiceTimeline(): VoiceTimeline {
  let entries: VoiceTimelineEntry[] = [];
  let turnStartMs: number | null = null;

  const mark = (name: VoiceTimelineMark, extra?: Record<string, unknown>): void => {
    const atMs = nowMs();
    if (turnStartMs === null) {
      turnStartMs = atMs;
    }
    const entry: VoiceTimelineEntry = { name, tMs: atMs - turnStartMs };
    if (extra !== undefined) {
      entry.extra = extra;
    }
    entries.push(entry);
  };

  const snapshot = (): VoiceTimelineEntry[] =>
    entries.map(({ name, tMs, extra }) => {
      const entry: VoiceTimelineEntry = { name, tMs: Math.round(tMs) };
      if (extra !== undefined) {
        entry.extra = extra;
      }
      return entry;
    });

  const gaps = (): Record<string, number> => {
    const firstAtMs = new Map<VoiceTimelineMark, number>();
    for (const { name, tMs } of entries) {
      if (!firstAtMs.has(name)) {
        firstAtMs.set(name, tMs);
      }
    }
    const result: Record<string, number> = {};
    for (const { name, from, to } of TIMELINE_GAPS) {
      const fromAt = firstAtMs.get(from);
      const toAt = firstAtMs.get(to);
      if (fromAt !== undefined && toAt !== undefined) {
        result[name] = Math.round(toAt - fromAt);
      }
    }
    return result;
  };

  const reset = (): void => {
    entries = [];
    turnStartMs = null;
  };

  const dump = (): void => {
    console.table(snapshot());
    console.log('voice-timeline gaps (ms)', gaps());
  };

  return { mark, snapshot, gaps, reset, dump };
}
