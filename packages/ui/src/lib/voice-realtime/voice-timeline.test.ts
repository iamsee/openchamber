import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import { createVoiceTimeline } from './voice-timeline';

const realNow = performance.now.bind(performance);

interface FakeClock {
  now: number;
}

const fakeClock = (startMs: number): FakeClock => {
  const clock: FakeClock = { now: startMs };
  spyOn(performance, 'now').mockImplementation(() => clock.now);
  return clock;
};

afterEach(() => {
  performance.now = realNow;
});

describe('createVoiceTimeline', () => {
  test('records marks in insertion order, relative to the first mark after reset', () => {
    const clock = fakeClock(1000);
    const timeline = createVoiceTimeline();

    timeline.mark('user_last_audio');
    clock.now = 1200;
    timeline.mark('asr_final', { text: 'hello' });
    clock.now = 1450;
    timeline.mark('turn_committed');
    clock.now = 1900;
    timeline.mark('llm_first_token');
    clock.now = 2300;
    timeline.mark('client_first_audible');

    const snapshot = timeline.snapshot();
    expect(snapshot.map((entry) => entry.name)).toEqual([
      'user_last_audio',
      'asr_final',
      'turn_committed',
      'llm_first_token',
      'client_first_audible',
    ]);
    expect(snapshot.map((entry) => entry.tMs)).toEqual([0, 200, 450, 900, 1300]);
    expect(snapshot[1]?.extra).toEqual({ text: 'hello' });
    expect(snapshot[2]?.extra).toBeUndefined();
  });

  test('computes the four key gaps from their endpoints', () => {
    const clock = fakeClock(0);
    const timeline = createVoiceTimeline();

    timeline.mark('user_last_audio');
    clock.now = 300;
    timeline.mark('asr_final');
    clock.now = 500;
    timeline.mark('turn_committed');
    clock.now = 1200;
    timeline.mark('llm_first_token');
    clock.now = 1500;
    timeline.mark('first_speakable_chunk');
    clock.now = 1700;
    timeline.mark('tts_first_audio');
    clock.now = 1900;
    timeline.mark('client_first_audible');

    expect(timeline.gaps()).toEqual({
      endpointWait: 300,
      sendToFirstToken: 700,
      firstTokenToAudible: 700,
      total: 1900,
    });
  });

  test('omits gaps whose endpoints are missing, and uses the first duplicate mark', () => {
    const clock = fakeClock(0);
    const timeline = createVoiceTimeline();

    timeline.mark('user_last_audio');
    clock.now = 300;
    timeline.mark('asr_final');

    expect(timeline.gaps()).toEqual({ endpointWait: 300 });

    clock.now = 800;
    timeline.mark('turn_committed');
    clock.now = 1000;
    timeline.mark('llm_first_token');
    clock.now = 1400;
    timeline.mark('llm_first_token');
    clock.now = 1800;
    timeline.mark('client_first_audible');

    expect(timeline.gaps()).toEqual({
      endpointWait: 300,
      sendToFirstToken: 200,
      firstTokenToAudible: 800,
      total: 1800,
    });
  });

  test('reset clears marks and re-anchors the turn start', () => {
    const clock = fakeClock(0);
    const timeline = createVoiceTimeline();

    timeline.mark('user_last_audio');
    clock.now = 500;
    timeline.mark('asr_final');
    timeline.reset();

    expect(timeline.snapshot()).toEqual([]);
    expect(timeline.gaps()).toEqual({});

    clock.now = 2000;
    timeline.mark('user_last_audio');
    clock.now = 2100;
    timeline.mark('client_first_audible');

    expect(timeline.snapshot().map((entry) => entry.tMs)).toEqual([0, 100]);
    expect(timeline.gaps()).toEqual({ total: 100 });
  });

  test('dump logs snapshot and gaps to console', () => {
    const clock = fakeClock(0);
    const tableSpy = spyOn(console, 'table').mockImplementation(() => {});
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    const timeline = createVoiceTimeline();

    timeline.mark('user_last_audio');
    clock.now = 250;
    timeline.mark('client_first_audible');
    timeline.dump();

    expect(tableSpy.mock.calls).toHaveLength(1);
    expect(tableSpy.mock.calls[0]?.[0]).toEqual([
      { name: 'user_last_audio', tMs: 0 },
      { name: 'client_first_audible', tMs: 250 },
    ]);
    expect(logSpy.mock.calls).toHaveLength(1);
    expect(logSpy.mock.calls[0]?.[0]).toBe('voice-timeline gaps (ms)');
    expect(logSpy.mock.calls[0]?.[1]).toEqual({ total: 250 });

    tableSpy.mockRestore();
    logSpy.mockRestore();
  });
});
