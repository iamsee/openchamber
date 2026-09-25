/**
 * The one AudioContext the realtime voice feature runs on.
 *
 * Capture and playback share it deliberately: both sides then read the same
 * `ctx.currentTime`, which is the clock echo calibration measures against and
 * the clock any future reference-aligned gating would need (plan §0 row 1,
 * §4 rule 6). It is NOT shared for echo cancellation — a shared context buys no
 * AEC of its own, and iOS WKWebView has no usable AEC at all. Acoustic echo is
 * measured per device instead (echo-calibration.ts).
 *
 * The context is created lazily and kept for the lifetime of the page. iOS only
 * resumes a context inside a user gesture, so recreating one per voice session
 * would throw the unlock away: `unlockRealtimeAudio()` is the gesture entry
 * point and `isRealtimeAudioSuspended()` is the foreground-return check
 * (plan §4 rule 5). Nothing here closes the context — `stop()` on a capture
 * handle releases the mic graph and leaves the context alone.
 */

type AudioContextConstructor = typeof AudioContext;

/** Safari prefixes the constructor; the lookup mirrors the dictation path. */
export const getAudioContextConstructor = (): AudioContextConstructor | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  const win = window as typeof window & { webkitAudioContext?: AudioContextConstructor };
  return win.AudioContext || win.webkitAudioContext || null;
};

let sharedContext: AudioContext | null = null;

export const getRealtimeAudioContext = (): AudioContext => {
  if (!sharedContext) {
    const AudioContextCtor = getAudioContextConstructor();
    if (!AudioContextCtor) {
      throw new Error('[voice-realtime] AudioContext is unavailable in this environment');
    }
    sharedContext = new AudioContextCtor();
  }
  return sharedContext;
};

/**
 * Resume the shared context and schedule one silent buffer. Must be called from
 * inside a user gesture; returns whether audio is actually running afterwards.
 *
 * The boolean is the error channel: a failed unlock is expected (autoplay policy
 * outside a gesture, iOS refusing a resume) and must not throw inside a gesture
 * handler. The caller shows the "tap to resume voice" affordance instead.
 */
export const unlockRealtimeAudio = async (): Promise<boolean> => {
  try {
    const context = getRealtimeAudioContext();
    if (context.state !== 'running') {
      await context.resume();
    }

    // iOS additionally wants a real buffer scheduled inside the gesture before
    // it will play anything later (useServerTTS.ts:206-228 does the same).
    const buffer = context.createBuffer(1, 1, context.sampleRate);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.onended = () => source.disconnect();
    source.start(0);

    return context.state === 'running';
  } catch {
    // Best-effort by contract — see the doc comment above.
    return false;
  }
};

/**
 * True when the shared context exists and cannot currently render audio, which
 * is the state iOS leaves it in after backgrounding, locking the screen, a call,
 * or Siri. 'interrupted' is a non-standard WKWebView state and 'closed' is
 * equally unusable, so anything that is not 'running' counts.
 */
export const isRealtimeAudioSuspended = (): boolean => {
  if (!sharedContext) {
    return false;
  }
  return sharedContext.state !== 'running';
};
