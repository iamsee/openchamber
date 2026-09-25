# Realtime voice module

Full-duplex spoken conversation: the client streams 16 kHz mono PCM16 over a
binary WebSocket while the server runs VAD, transcribes each turn, streams an
LLM reply through a sentence chunker, synthesizes each sentence, and pushes the
audio back — with barge-in, so the user can talk over the assistant.

This is deliberately not an extension of `../dictation`. Dictation is
half-duplex and transcript-shaped: it buffers a segment, decodes it once on
commit, and hands text to the composer. Its `commit()` zeroes the session's PCM
buffer, which makes a speculative commit (decode at ~300 ms of silence, keep
recording, commit for real at ~700 ms) impossible, and its built-in silence
auto-commit needs `segmentMinSeconds=60` to stay out of the way, which is
useless for conversation. So this module owns its own audio buffer and calls
`transcribeAudio` from `../tts/stt.js` directly, reusing that module's helpers
rather than its session lifecycle.

Turn-taking is built on per-segment finals, not word-level partials: the STT
backend emits a transcript only on commit and always reports it as final.

## Ownership

- `protocol.js` — endpoint path, payload limits, heartbeat interval, and the
  binary frame codec for the three tags. Pure; no I/O.
- `vad.js` — `createVad`, turn detection. Pure; no I/O, no timers. Adaptive
  noise floor, two speech-start thresholds, `carryForward()`/`reset()`.
- `sentence-chunker.js` — `createSentenceChunker`, LLM token stream to speakable
  sentences. Pure.
- `tts.js` — `createTtsSynthesizer`, per-sentence synthesis against
  `/v1/audio/speech`. Streams the response body and yields PCM incrementally;
  `../tts/service.js` cannot be reused because it buffers the whole response
  (`await response.arrayBuffer()`) and sends no `response_format` at all when a
  custom baseURL is set.
- `brain.js` — `createBrain`, the switchable LLM adapter. `assistant` mode is
  implemented; `session` mode throws `VoiceRealtimeNotImplementedError`.
- `session.js` — `createVoiceRealtimeSession`, one per connection. The
  `IDLE/LISTENING/THINKING/SPEAKING` state machine, the 1.5 s mic ring buffer,
  the STT buffer and speculative commit, the single-slot STT serialiser,
  barge-in, history truncation, and every `turnId` gate.
- `runtime.js` — `createVoiceRealtimeRuntime`, registers the
  `/api/voice/realtime` WebSocket endpoint (auth-gated the same way as the
  dictation and terminal sockets: UI session token or `oc_url_token`, plus an
  origin check) and owns heartbeat and teardown. Created from the startup
  pipeline (`../opencode/startup-pipeline-runtime.js`) **before** the generic
  OpenCode proxy so the upgrade route is not shadowed.

No HTTP routes. Settings live in the existing settings store and reach the
server inside the client's `start` control message; a config endpoint would be
a second source of truth.

## Protocol

Every WebSocket message is binary. Byte 0 is the frame tag.

| Tag | Direction | Layout |
|---|---|---|
| `0x01` | both | tag \| UTF-8 JSON control object |
| `0x02` | client → server | tag \| `seq` u32 BE \| `sampleRate` u32 BE \| PCM16LE mono |
| `0x03` | server → client | tag \| `turnId` u32 BE \| `sentenceIndex` u8 \| `format` u8 \| `sampleRate` u32 BE \| payload |

`format` is `0` for raw PCM16LE (a WAV body with the 44-byte header stripped
server-side) and `1` for the MP3 degradation fallback.

Mic frames are exactly 1600 samples (3200 bytes) = 100 ms at 16 kHz. `seq` is a
debug counter only: WebSocket over TCP is already ordered and reliable, so there
is no ack and no reorder buffer here.

Client → server control: `start {sessionId, config}`, `barge_in`, `end_turn`,
`calibration {echoPeak, fullDuplexSafe}`, `stop`, `ping`.

Server → client control: `ready {sessionId, defaults}`,
`state {state, turnId}`, `vad {voiced}`,
`user_text {turnId, text, final, speculative}`,
`assistant_text {turnId, delta, text, final}`, `flush_audio {turnId}`,
`audio_end {turnId}`, `calibration {echoPeak, fullDuplexSafe}`,
`error {error, retryable, reasonCode?}`, `pong`.

`turnId` is a monotonically increasing integer, not a string, so it fits the
binary header directly and comparisons at every await boundary are cheap. It is
`0` until the first detected speech onset; the first real turn is `1`.

`config` in `start` follows the client contract:

```jsonc
{
  "brain": "assistant",                       // "assistant" | "session"
  "provider": { "url": "...", "model": "...", "apiKey": "..." },
  "stt":      { "url": "...", "model": "...", "apiKey": "...", "language": "zh" },
  "tts":      { "url": "...", "model": "...", "voice": "...", "apiKey": "..." }
}
```

`calibration` is an additive extension: the client measures echo return loss
(it owns the mic and the playback clock) and reports it, and the server echoes
it back so both sides agree on whether VAD-triggered barge-in is enabled.

## Documented defaults

Measured on the real backend; every value is overridable through `start.config`.

| Role | Default |
|---|---|
| Assistant brain | `https://langfuse-relayx.isvbytes.com/v1`, model `deepseek-v4-flash-0731` (TTFT 1.29 s, 127 chars/s) |
| STT | `http://10.10.10.100:30097/v1`, model `SenseVoiceSmall` |
| TTS | `http://10.10.10.100:30097/v1`, model `kokoro`, voice `zf_001`, `response_format: 'wav'` → PCM16 mono 24000 Hz |
| Mic | 16000 Hz, 100 ms frames |
| Ring buffer / pre-roll | 1500 ms / 250 ms |
| VAD | speech start 300 ms, speculative silence 300 ms, commit silence 700 ms, barge-in 200 ms, `floorK` 4, `bargeInFloorK` 10 |
| Chunker | first sentence ≤ 12 chars, `minChars` 6, `maxChars` 60 |
| Backpressure | pause audio at `bufferedAmount > 1_000_000` |

**API keys are never defaulted in code or in this file.** They arrive in
`start.config` from the settings store, or fall back to `OPENAI_API_KEY` the
same way `../tts/stt.js` does. Committing a working key to the repository would
outlive the branch it was written on.

Two consequences of reusing `normalizeCustomOpenAIBaseURL` from
`../tts/base-url.js` for every outbound URL:

- The existing SSRF guard applies. Both documented defaults are non-loopback
  hosts, so the server needs `OPENCHAMBER_ALLOW_REMOTE_OPENAI_COMPAT_URLS=true`
  (or `OPENCHAMBER_RUNTIME=desktop`) to reach them — the same rule the dictation
  and TTS providers already follow.
- A URL carrying credentials, or a non-http(s) scheme, is rejected before any
  request is made.

## TTS container

`response_format: 'wav'` is the primary path, verified against the target
backend:

| `response_format` | HTTP | Result |
|---|---|---|
| `wav` | 200 | RIFF WAVE, Microsoft PCM, 16-bit, mono, 24000 Hz — 163244 bytes in 1.10 s for a 12-char sentence |
| `mp3` | 200 | MPEG layer III, 24 kHz mono — 19608 bytes in 1.32 s |
| `pcm` | 500 | unsupported |
| `opus` | 500 | unsupported |

WAV wins on both quality and latency: zero codec delay or padding means
sentences concatenate sample-exactly with no rhythmic stutter, the 44-byte
header is stripped server-side so the client writes samples straight into
`createBuffer` + `copyToChannel` instead of paying a main-thread
`decodeAudioData`, and skipping the encode step makes it faster than MP3
(0.32× realtime, which is what makes sentence pipelining viable).

The cost is bandwidth: 24000 Hz × 2 B = 48 KB/s downstream while speaking,
versus ~2.4 KB/s for MP3. Acceptable — below a music stream, and downstream is
rarely the constrained direction. A backend that refuses WAV degrades to MP3
for that sentence rather than failing the turn; MP3 codec padding then has to be
trimmed from the *decoded* audio, which is the client's job because this server
has no MP3 decoder and takes no new dependencies. `trimPcm16NearSilence` is the
server-side equivalent for PCM payloads and is opt-in (`trimPcmSilence`, off by
default) since the verified container needs no trim.

Do not assume the TTS sample rate equals the client's `AudioContext` rate: iOS
locks the context to the hardware rate (48 k, or 24 k/44.1 k over Bluetooth)
while Kokoro is 24 k. The `sampleRate` field in tag `0x03` exists so the client
can build the buffer at the right rate.

## Turn taking

```
mic frame ──► ring buffer (1.5 s, always filling)
          ──► STT buffer (current turn only, frozen at an endpoint)
          ──► VAD
                LISTENING → speech ≥ 300 ms          → new turn, seed pre-roll
                            silence ≥ 300 ms         → SPECULATIVE commit (buffer kept)
                            silence ≥ 700 ms         → REAL commit → THINKING
                SPEAKING  → barge-in detector only (floor frozen, no commit VAD)
```

The speculative commit exists to remove one STT round-trip from the critical
path (measured −0.4 s). It decodes the buffer at 300 ms of silence and freezes
the buffer, so if the user does not resume, the real commit at 700 ms reuses
that transcript verbatim instead of decoding the same audio twice. If the user
does resume, the buffer unfreezes, the stale decode is cancelled, and the real
commit decodes the whole thing.

STT runs through a single-slot serialiser: at most one decode in flight and at
most one queued, and enqueuing while one is already queued **cancels the
queued-but-unstarted job**. Aborting an in-flight request does not free the
inference backend's CPU, so the only reliable protection against a backlog of
stale decodes on a 4-core host is never letting them start.

## Invariants

- `turnId` is checked after EVERY await boundary and gated at the audio send
  site. Work belonging to an interrupted turn can never write to the socket.
- On barge-in, `flush_audio` is sent FIRST and synchronously — before `turnId`
  is bumped and before anything is aborted. Everything else races the interrupt.
- Barge-in calls `vad.carryForward()`, never `vad.reset()`. The adaptive noise
  floor learned before the assistant spoke is still the right baseline;
  relearning it would leave the next turn with no threshold for a second or two.
- No commit VAD while SPEAKING. Only the barge-in detector runs, against a
  much higher threshold, and the noise floor is frozen so the assistant's own
  echo cannot raise the baseline it is measured against.
- The threshold is an adaptive noise floor (slow RMS percentile × K), never a
  static peak level. Capture runs with AGC off, but the room still moves.
- History records only what the user actually heard: the assistant turn is
  truncated to the last sentence whose audio was fully written to the socket. A
  reply cut off by barge-in must not claim sentences that were synthesized but
  never played.
- Silence-only audio (PCM peak < 300) is never sent to STT, so Whisper-style
  providers do not hallucinate on it.
- The mic sample rate is fixed at 16 kHz for the life of a connection; a frame
  with any other rate is a protocol error, not audio to be resampled.
- Audio sends wait for `socket.bufferedAmount` to fall below 1 MB. Speech is
  48 KB/s downstream, and an undrained slow client would otherwise buffer whole
  sentences in server memory.
- `/api/voice/realtime` is allowlisted in exactly two places —
  `../ui-auth/ui-auth.js` (`isUrlAuthWebSocketPath`) and
  `../relay/tunnel-host.js` (`ALLOWED_WS_PATHS`). It is deliberately absent from
  `../realtime-proxy.js`, which does not list `/api/dictation/ws` either.
- `session` brain mode is a typed stub. It is a separate half-duplex
  push-to-talk state machine in which barge-in means cancelling an agent run —
  an explicit, confirmed user action, never VAD-triggered.

## Not verified

iOS acoustics. The mobile shell has no `UIBackgroundModes`, no
`AVAudioSession` configuration and no audio Capacitor plugin, so there is no
usable AEC and the output route may fall to the earpiece receiver instead of the
loudspeaker. Neither is fixable from JS. The design degrades instead of
assuming: the client's startup calibration probe measures per-device echo return
loss, and when it reports `fullDuplexSafe: false` the server disables
VAD-triggered barge-in so only an explicit `barge_in` control interrupts. That
path is implemented and unit-tested; the acoustic behaviour behind it needs a
physical device.
