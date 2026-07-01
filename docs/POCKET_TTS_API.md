# PocketTTS Sidecar — API & Deployment Notes

Reference doc for the `pocket-tts` Docker sidecar (issue #6). Covers the
confirmed HTTP contract, how to run it, and the CPU-throughput benchmark that
informs `TTS_MAX_CHUNK_CHARS` / `TTS_MAX_CONCURRENT_JOBS` defaults.

Full design rationale lives in [POCKET_TTS_INTEGRATION.md](./POCKET_TTS_INTEGRATION.md).

## Source

- Upstream server: [bytetrie/pocket-tts-deno](https://github.com/bytetrie/pocket-tts-deno)
  (Deno port of kyutai-labs/pocket-tts; CPU-only ONNX INT8).
- Models: `kyutai/pocket-tts` (CC BY 4.0) — baked into our image via the
  upstream repo's git-lfs-tracked `onnx/*.onnx` files (~190 MB total).
- No official image exists; we author `docker/pocket-tts/Dockerfile`.

## Running

```bash
# Production compose (sidecar + app + postgres)
docker compose up -d pocket-tts
docker compose up -d                  # app depends_on pocket-tts (healthy)

# Dev compose (sidecar only; app runs on host, talks to localhost:8001)
docker compose -f docker-compose.dev.yml up -d pocket-tts

# Quick smoke test against the published loopback port
curl -s http://127.0.0.1:8001/health
curl -s http://127.0.0.1:8001/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{"input":"Hello world!","voice":"cosette"}' > speech.wav
```

The sidecar takes ~1–2 min to reach `ready` on a cold start (five INT8 ONNX
sessions + default-voice pre-conditioning). The compose healthcheck uses
`start_period: 120s` to account for this. While loading, `GET /health` returns
`503 {"status":"loading"}`; once ready, `200 {"status":"ready"}`.

## Confirmed API contract

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Readiness (`200` ready / `503` loading) |
| `/` | GET | Server info + endpoint summary |
| `/v1/voices` | GET | List voices: `{ voices, builtin, custom }` |
| `/v1/voices?name=<id>` | POST | Register a custom voice from a WAV upload (≤10 s, mono/any-rate resampled to 24 kHz, PCM16/32/IEEE float). Ephemeral — lost on restart. |
| `/v1/voices/:name` | DELETE | Remove a custom voice (built-ins can't be deleted) |
| `/v1/audio/speech` | POST | Synthesize; streams `audio/wav` (24 kHz mono PCM16, chunked, placeholder RIFF size `0xFFFFFFFF`) |

### `POST /v1/audio/speech`

Request body (JSON):

| Field | Type | Default | Behaviour |
|-------|------|---------|-----------|
| `input` | string | required | **Plain text** (not SSML). Server normalises numbers/unicode and chunks internally at ≤50 SentencePiece tokens. No max length enforced server-side. |
| `voice` | string | `"cosette"` | Built-in (`cosette`, `jean`, `fantine`) or a registered custom id. Unknown → `400`. |
| `speed` | number | `1.0` | **Accepted but ignored.** Expose playback-rate on the client `<audio>` element instead. |
| `response_format` | string | `"wav"` | **Accepted but ignored** — always WAV. |

Response: `200`, `Content-Type: audio/wav`, `Transfer-Encoding: chunked`,
streaming 24 kHz mono PCM16. WAV header written immediately with a streaming
placeholder size; audio appended frame-by-frame — progressively playable.
`503` while models load.

### Cross-cutting

- **CORS open** server-side, but BookOrbit's app CSP blocks direct
  browser→sidecar calls; NestJS proxies TTS (`/api/v1/tts/synthesize`,
  `/api/v1/tts/voices`) so the browser never talks to the sidecar directly.
- **No auth** — rely on loopback port binding + the compose-internal network.
- **No language parameter** — language follows the model/voice, not a request
  field.
- **Streaming WAV with unknown length** — clients needing a known size must
  buffer the full stream first.

## Throughput benchmark

> **TODO** — measure after the image builds and record here. This number sets
> `TTS_MAX_CHUNK_CHARS` (so a chunk finishes within
> `TTS_REQUEST_TIMEOUT_MS`) and the `TTS_MAX_CONCURRENT_JOBS` default
> (the sidecar is CPU-bound; running more than one job saturates cores).

### Method

Run a single request and compare the generated audio duration to the
wall-clock time to produce it:

```bash
# Audio duration (seconds) — ffprobe needs ffmpeg on the host
ffprobe -v error -show_entries format=duration -of csv=p=0 speech.wav

# Wall-clock time for the request (curl measures end-to-end incl. streaming)
curl -s -o speech.wav \
  -w 'wall_clock=%{time_total}s\n' \
  http://127.0.0.1:8001/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{"input":"<paste a ~3000-char paragraph here>","voice":"cosette"}'
```

Report **audio-seconds per wall-clock-second** (realtime factor) on the target
CPU. Repeat for a few input lengths (short block, ~3000-char chunk) since the
voice-conditioning cache warms after the first request with a given voice.

### Results

Measured 2026-07-01 against the image built from `docker/pocket-tts/Dockerfile`
(brand-new container; default voice `cosette` pre-conditioned on startup).

| CPU | Cores | Input chars | Voice | Audio (s) | Wall-clock (s) | Realtime factor | Date |
|-----|-------|-------------|-------|-----------|----------------|-----------------|------|
| AMD Ryzen 7 9800X3D | 8C/16T | 12 | cosette | 0.96 | 0.29 | 3.3× | 2026-07-01 |
| AMD Ryzen 7 9800X3D | 8C/16T | 3060 | cosette | 194.14 | 45.52 | 4.26× | 2026-07-01 |

Realtime factor = audio-seconds ÷ wall-clock-seconds. It improves with input
length as the per-request voice-conditioning / warmup overhead is amortised —
steady state for a full chunk is ~**4.2× realtime** on this CPU. Voice cache is
warm for repeated same-voice requests.

### Defaults derived

- **`TtsMaxChunkChars`**: at ~4.2× realtime a 3000-char chunk yields ~194 s of
  audio in ~45.5 s wall-clock. The default `TTS_REQUEST_TIMEOUT_MS=30000`
  (30 s) is therefore too short for a full 3000-char chunk on this hardware;
  either raise the timeout to ~60 s or lower the chunk cap to ~2000 chars
  (~30 s wall-clock at steady state). **Tuning belongs to issue #2**, which lands
  the consuming config; the `.env.example` defaults (`3000` / `30000`) are
  conservative starting points to revisit once #2 lands.
- **`TTS_MAX_CONCURRENT_JOBS`: a single request already saturates the CPU cores
  (onnxruntime-node sets `intraOpNumThreads` = hardware cores). Concurrency > 1
  would not speed aggregate throughput and would hurt latency of the in-flight
  request — keep `1` as the default. Raise only if profiling shows a single job
  leaving cores idle (e.g. on a many-core box with a short input).