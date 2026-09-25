# Realtime voice — client audio layer

## Authority

This directory owns microphone capture, the voice WebSocket transport, TTS
playback scheduling, and the echo calibration probe for the realtime voice
conversation feature. The normative module API is
`.opencode/plans/realtime-voice.md` §10; the wire layout is §5.1. If this file
and §10 disagree, §10 wins and this file is stale.

The orchestration hook (`hooks/useRealtimeVoice.ts`), the panel components and
the settings keys are owned by other parts of the feature; they consume the
exports below and must not reach into the internals.

## Module map

| Module | Owns |
|---|---|
| `protocol.ts` | Pure wire codec (tags `0x01`/`0x02`/`0x03`) + control/audio types. Server mirror: `packages/web/server/lib/voice-realtime/protocol.js`; the two must stay byte-compatible. |
| `audio-context.ts` | The single shared `AudioContext` and the iOS unlock/suspend checks. |
| `capture-frame.ts` | Pure framing DSP (resample to 16 kHz, exact 1600-sample Int16 frames, level) + the processor name and message shape shared by the worklet and the main thread. |
| `capture-processor.worklet.ts` | The AudioWorklet processor. Render-thread only. |
| `audio-source.ts` | getUserMedia + worklet wiring; capture lifecycle and the level subscription. |
| `audio-queue.ts` | Gapless scheduling, master gain, `flush()` ramp, turnId gating, MP3 silence trim. |
| `realtime-voice-client.ts` | WS transport; mirrors `dictation-client.ts` connection order and relay requirements. |
| `echo-calibration.ts` | The per-device echo probe. |

## Invariants (each one is a shipped bug if broken)

1. **One shared AudioContext** for capture and playback, justified by the single
   `ctx.currentTime` clock — explicitly *not* by AEC, which a shared context does
   not provide and which iOS WKWebView lacks. The context is never closed by a
   capture stop.
2. **The mic graph never reaches `context.destination`**, not even through a
   zero-gain node. The capture worklet has `numberOfOutputs: 0` and is pulled by
   its input alone.
3. **Capture frames are exactly 1600 samples at 16 kHz** (100 ms). The server VAD
   counts 100 ms frames; a short frame shifts every downstream timing decision.
   AGC off, echo cancellation on, noise suppression off.
4. **Format 0 audio never touches `decodeAudioData`.** Raw PCM16 goes straight
   into `createBuffer` + `copyToChannel` at the *TTS* sample rate (24 kHz for
   Kokoro), never the context rate; Web Audio resamples on playback and
   `buffer.duration` stays correct. `decodeAudioData` exists only on the MP3
   fallback, which is also the only path that trims near-silence. Cross-fading is
   rejected.
5. **Every audio frame is gated on `turnId`, at enqueue and again after any
   await.** Frames still in flight when `flush_audio` arrives are dropped, not
   played. A flush ramps the master gain to 0 over ~5 ms *before* stopping
   sources, and every `onended` handler is turnId-guarded so the interrupt storm
   cannot move the caller's state machine.
6. **Levels are delivered by subscription, never React state** (10 Hz updates
   re-rendered the dictation overlay when they went through state).

## Transport notes

- Connect order is fixed by the relay contract: `refreshRuntimeUrlAuthToken()` →
  `getRuntimeUrlResolver().websocket('/api/voice/realtime')` →
  `openRuntimeWebSocket(url)` from `@/lib/relay/runtime-socket`, with
  `binaryType = 'arraybuffer'` (the native default Blob is dropped by the relay
  wrapper). The path must also be allowlisted in `ui-auth.js` and
  `tunnel-host.js` (server side).
- `connect()` resolves on socket open. `ready` is the server's reply to the
  client's `start` and arrives through `onControl`.
- Connection loss has no dedicated callback: it surfaces as an `error` control
  message with `reasonCode` `transport_closed` or `runtime_changed`
  (`realtime-voice-client.ts` exports both constants). A runtime switch tears the
  socket down; the conversation state does not survive it.

## Calibration

`calibrateEcho({ capture, playSample })` plays the caller's ~1 s probe while
subscribed to the capture's level feed, measures an ambient window first and the
playback + 200 ms tail second, and returns the echo level as the difference in
energy. `fullDuplexSafe` means the device's echo return stays below
`FULL_DUPLEX_SAFE_ECHO_PEAK`; when it is false the UI should offer push-to-talk
instead of silent self-interrupts. iOS is the motivating case and remains
unverified until a physical-device test (plan §1).

## Testing

Pure parts are unit-tested in place (`protocol.test.ts`, `capture-frame.test.ts`,
`audio-queue.test.ts`, `echo-calibration.test.ts`); the queue tests run against
a fake AudioContext that logs cross-node ordering so "ramp before stop" is an
assertable sequence. Browser-only wiring (getUserMedia, `addModule`, the relay
socket) is exercised end-to-end per plan §9.4/§11 rather than mocked here.
