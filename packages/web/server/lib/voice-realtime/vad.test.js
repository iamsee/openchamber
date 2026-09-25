import { describe, expect, it } from 'bun:test';

import { createVad, VAD_MODE_IDLE, VAD_MODE_LISTENING, VAD_MODE_SPEAKING } from './vad.js';

const FRAME_SAMPLES = 1600;
const FRAME_BYTES = FRAME_SAMPLES * 2;

const sineFrame = (amplitude, samples = FRAME_SAMPLES) => {
  const arr = new Int16Array(samples);
  for (let i = 0; i < samples; i += 1) {
    arr[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 220 * i) / 16000));
  }
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
};

const silentFrame = (samples = FRAME_SAMPLES) => Buffer.alloc(samples * 2);

const pushFrames = (vad, frame, count) => {
  const events = [];
  for (let i = 0; i < count; i += 1) {
    events.push(vad.push(frame));
  }
  return events;
};

// A quiet room: amplitude 100 puts the normalized RMS at ~0.0022, just above the
// 0.0015 minimum floor, so the onset threshold lands near 0.0086.
const QUIET = sineFrame(100);
// Amplitude 6000 is ~0.13 normalized RMS — far above a quiet-room onset, and far
// BELOW the onset implied by a loud background. The pair is what proves the
// threshold adapts instead of being a fixed level.
const SPEECH = sineFrame(6000);
const LOUD_BACKGROUND = sineFrame(3000);

describe('createVad turn initiation', () => {
  it('fires speechStarted once onset energy sustains for speechStartMs', () => {
    const vad = createVad();
    pushFrames(vad, QUIET, 20);

    const events = pushFrames(vad, SPEECH, 5);
    expect(events[0].speechStarted).toBe(false);
    expect(events[1].speechStarted).toBe(false);
    expect(events[2].speechStarted).toBe(true);
    expect(events[3].speechStarted).toBe(false);
  });

  it('does not fire on energy below the adaptive threshold', () => {
    const vad = createVad();
    pushFrames(vad, QUIET, 20);

    const events = pushFrames(vad, sineFrame(200), 10);
    expect(events.some((e) => e.speechStarted)).toBe(false);
  });

  it('adapts the floor so the same amplitude stops triggering on a loud background', () => {
    const quietRoom = createVad();
    pushFrames(quietRoom, QUIET, 20);
    expect(pushFrames(quietRoom, SPEECH, 5).some((e) => e.speechStarted)).toBe(true);

    const loudRoom = createVad();
    pushFrames(loudRoom, LOUD_BACKGROUND, 20);
    expect(pushFrames(loudRoom, SPEECH, 5).some((e) => e.speechStarted)).toBe(false);
    expect(loudRoom.floor).toBeGreaterThan(quietRoom.floor * 10);
  });
});

describe('createVad endpoints', () => {
  it('fires the speculative endpoint at ~300 ms of silence and the real one at ~700 ms', () => {
    const vad = createVad();
    pushFrames(vad, QUIET, 20);
    pushFrames(vad, SPEECH, 5);

    const events = pushFrames(vad, silentFrame(), 10);
    const speculativeAt = events.findIndex((e) => e.speculativeEndpoint);
    const endpointAt = events.findIndex((e) => e.endpoint);

    expect(speculativeAt).toBe(2);
    expect(endpointAt).toBe(6);
    expect(events.filter((e) => e.speculativeEndpoint)).toHaveLength(1);
    expect(events.filter((e) => e.endpoint)).toHaveLength(1);
  });

  it('never fires an endpoint before speech has started', () => {
    const vad = createVad();
    pushFrames(vad, QUIET, 20);

    const events = pushFrames(vad, silentFrame(), 20);
    expect(events.some((e) => e.speculativeEndpoint || e.endpoint)).toBe(false);
  });

  it('re-arms for the next turn after the real endpoint', () => {
    const vad = createVad();
    pushFrames(vad, QUIET, 20);
    pushFrames(vad, SPEECH, 5);
    pushFrames(vad, silentFrame(), 10);

    expect(pushFrames(vad, SPEECH, 5).some((e) => e.speechStarted)).toBe(true);
  });
});

describe('createVad barge-in', () => {
  it('detects barge-in while SPEAKING and suppresses all commit VAD', () => {
    const vad = createVad();
    vad.setMode(VAD_MODE_SPEAKING);

    const events = pushFrames(vad, SPEECH, 4);
    expect(events[0].bargeIn).toBe(false);
    expect(events[1].bargeIn).toBe(true);
    expect(events.some((e) => e.speechStarted || e.speculativeEndpoint || e.endpoint)).toBe(false);

    const tail = pushFrames(vad, silentFrame(), 20);
    expect(tail.some((e) => e.speculativeEndpoint || e.endpoint)).toBe(false);
  });

  it('fires barge-in exactly once per speaking episode', () => {
    const vad = createVad();
    vad.setMode(VAD_MODE_SPEAKING);

    const events = pushFrames(vad, SPEECH, 10);
    expect(events.filter((e) => e.bargeIn)).toHaveLength(1);
  });

  it('does not report barge-in while LISTENING', () => {
    const vad = createVad();
    pushFrames(vad, QUIET, 20);

    expect(pushFrames(vad, SPEECH, 10).some((e) => e.bargeIn)).toBe(false);
  });

  it('needs a far higher threshold than turn initiation', () => {
    const vad = createVad();
    vad.setMode(VAD_MODE_SPEAKING);

    // Amplitude 300 (~0.0065 normalized RMS) crosses the listening onset
    // (~0.006) but not the barge-in bar (~0.015).
    expect(pushFrames(vad, sineFrame(300), 10).some((e) => e.bargeIn)).toBe(false);
    expect(pushFrames(vad, sineFrame(6000), 10).some((e) => e.bargeIn)).toBe(true);
  });

  it('freezes the noise floor while SPEAKING so echo cannot raise it', () => {
    const vad = createVad();
    pushFrames(vad, QUIET, 20);
    const floorBeforeSpeaking = vad.floor;

    vad.setMode(VAD_MODE_SPEAKING);
    pushFrames(vad, sineFrame(20000), 20);

    expect(vad.floor).toBe(floorBeforeSpeaking);
  });
});

describe('createVad modes', () => {
  it('reports nothing while IDLE', () => {
    const vad = createVad();
    vad.setMode(VAD_MODE_IDLE);

    const events = pushFrames(vad, SPEECH, 10);
    expect(events.every((e) => !e.voiced && !e.speechStarted && !e.bargeIn && !e.endpoint)).toBe(true);
  });

  it('resumes turn detection when it returns to LISTENING', () => {
    const vad = createVad();
    pushFrames(vad, QUIET, 20);
    vad.setMode(VAD_MODE_IDLE);
    pushFrames(vad, SPEECH, 10);
    vad.setMode(VAD_MODE_LISTENING);

    expect(pushFrames(vad, SPEECH, 5).some((e) => e.speechStarted)).toBe(true);
  });

  it('rejects an unknown mode', () => {
    const vad = createVad();
    expect(() => vad.setMode('shouting')).toThrow(/unknown VAD mode/);
  });
});

describe('createVad carryForward', () => {
  it('keeps the adaptive noise floor', () => {
    const vad = createVad();
    pushFrames(vad, QUIET, 20);
    const floor = vad.floor;

    vad.carryForward();
    expect(vad.floor).toBe(floor);

    vad.reset();
    expect(vad.floor).toBeLessThan(floor);
  });

  it('re-arms speechStarted so a barge-in turn is detected immediately', () => {
    const vad = createVad();
    pushFrames(vad, QUIET, 20);
    pushFrames(vad, SPEECH, 5);

    vad.carryForward();
    const events = pushFrames(vad, SPEECH, 5);
    expect(events.some((e) => e.speechStarted)).toBe(true);
  });

  it('clears a pending endpoint so the interrupted turn cannot commit', () => {
    const vad = createVad();
    pushFrames(vad, QUIET, 20);
    pushFrames(vad, SPEECH, 5);
    pushFrames(vad, silentFrame(), 4);

    vad.carryForward();
    expect(pushFrames(vad, silentFrame(), 10).some((e) => e.speculativeEndpoint || e.endpoint)).toBe(false);
  });
});

describe('createVad framing', () => {
  it('carries a partial frame into the next push', () => {
    const vad = createVad();
    pushFrames(vad, QUIET, 20);

    const half = SPEECH.subarray(0, FRAME_BYTES / 2);
    expect(vad.push(SPEECH).voiced).toBe(true);
    expect(vad.push(half).voiced).toBe(false);
    expect(vad.push(half).voiced).toBe(true);
    expect(vad.push(SPEECH).speechStarted).toBe(true);
  });

  it('exposes the frame size in bytes', () => {
    expect(createVad().frameBytes).toBe(FRAME_BYTES);
    expect(createVad({ sampleRate: 8000, frameMs: 100 }).frameBytes).toBe(1600);
  });

  it('honours custom timings', () => {
    const vad = createVad({ speechStartMs: 100, speculativeSilenceMs: 100, commitSilenceMs: 200 });
    pushFrames(vad, QUIET, 20);

    expect(vad.push(SPEECH).speechStarted).toBe(true);
    const events = pushFrames(vad, silentFrame(), 4);
    expect(events[0].speculativeEndpoint).toBe(true);
    expect(events[1].endpoint).toBe(true);
  });
});
