# PocketTTS Integration — Viability Assessment

> Status: **Investigation / design** (no code written yet)
> Date: 2026-07-01
> PocketTTS source confirmed: [bytetrie/pocket-tts-deno](https://github.com/bytetrie/pocket-tts-deno) (`server.ts`, 1443 lines). API contract recorded in §8.

Goal: integrate a self-hosted **PocketTTS** Docker sidecar so BookOrbit can
(a) read an eBook aloud from the built-in web reader, and
(b) convert an eBook into an audiobook asynchronously, notifying the user on
completion.

## TL;DR

**Highly viable.** The codebase already has every primitive this feature needs:

- A TTS engine that emits **SSML + word-level marks** from the EPUB DOM
  (`client/public/assets/foliate/tts.js`) — the block-walker + mark machinery
  gives block-level read-aloud with synchronized block highlighting.
- A full **audiobook player** (`AudiobookReaderView.vue`) that plays M4B/MP3 —
  a generated audiobook needs no new player, just a new `book_file` row.
- A complete **notification system** (persisted + realtime WebSocket push) for
  the "you've been notified when it's done" half of Mode B.
- A proven **external-service + async-job module pattern** (Hardcover) to copy.
- A pluggable **file-write** layer for persisting generated output into the
  library.

The PocketTTS HTTP API contract is **confirmed** (§8): OpenAI-shaped
`POST /v1/audio/speech` taking **plain text** (not SSML) and returning a
**streaming WAV**. The two real deltas this forces: (1) strip foliate's SSML to
plain text per block, and (2) highlight sync is **block-level** (PocketTTS
returns no word timestamps), not word-level karaoke.

---

## 1. Relevant existing architecture

### 1.1 Foliate TTS engine (`client/public/assets/foliate/tts.js`)

The vendored foliate library ships a `TTS` class that:

- Walks the EPUB DOM in block order (`getBlocks`).
- For each block, builds a **W3C SSML** document via `fragmentToSSML()`, and
  inserts `<mark name="...">` elements at word boundaries using an
  `Intl.Segmenter` (`getFragmentWithMarks`).
- Exposes `start() / next() / prev() / resume() / from(range) / setMark(mark)`
  returning an **SSML string** plus a `Range` for highlighting.

Today nothing in the Vue reader wires this up to `speechSynthesis` (a grep for
`tts`/`speechSynthesis` in `client/src/features/reader` returns nothing). The
engine is present but unused — i.e. an open integration point, not a
replacement.

**Implication for Mode A (live read-aloud):** instead of handing each block
to the browser's `speechSynthesis`, get the block's plain text from the TTS
class (strip the SSML wrapper — foliate's `#speak(doc)` without a mark-getter
serializes plain text), POST it to the PocketTTS sidecar, and play the
returned streaming WAV. On `ended`, call `tts.next()` for the next block.
`setMark()` + the `overlayer.js` SVG layer highlights the **current block**
being spoken. Word-level karaoke is *not* available because PocketTTS returns
no word timestamps — block-level sync is the honest scope.

### 1.2 Audiobook reader (`client/src/features/reader/audiobook/`)

`AudiobookReaderView.vue` + composables (`useAudioQueue`, `useAudioProgress`,
`useAudioBookmarks`, `useAudioSettings`) is a complete HTML5-audio player:
queue across multiple files, chapter list, bookmarks, progress tracking,
sleep timer, speed/volume. It selects playable files via:

```ts
const AUDIO_EXTS = new Set(['m4b','m4a','mp3','opus','ogg','flac'])
```

**Implication for Mode B (async conversion):** a generated M4B/MP3 is just
another audio `book_file` attached to the book. Once the scanner picks it up
(or the row is inserted directly), it appears in this reader with zero new UI.

### 1.3 EPUB server module (`server/src/modules/reader/epub/epub.service.ts`)

Already parses EPUB structure server-side with `unzipper` + `fast-xml-parser`:
reads `container.xml` → OPF → spine/manifest/nav, caches book info, and can
stream individual XHTML files from the zip (`streamFile`). It does **not**
currently emit plain-text, but adding a "extract spine text in reading order"
method (strip tags from each spine XHTML, respect manifest order) is a small,
in-module addition. This is the text source for Mode B.

### 1.4 Notification system (`server/src/modules/notification/`)

- `NotificationService.notify(payload)` — persists to DB **and** pushes
  realtime via the Socket.IO gateway. Scopes: `library | user | permission |
  all`. Takes `type`, `title`, `message`, `actionUrl`, `meta`.
- `NotificationGateway` (`@WebSocketGateway('/notifications')`) emits
  `notification:new`, `notification:unread-count`, etc., joined per-user room
  `user:${userId}` after JWT verification.

**Implication for Mode B:** on conversion completion call
`notify({ type: 'tts.conversion_complete', scope: { kind:'user', userId },
actionUrl: '/reader/...', meta: { bookId, fileId } })`. The user gets the
in-app toast + bell instantly, no polling.

### 1.5 External-service pattern (`server/src/modules/hardcover/`)

The Hardcover module is the template to clone for a TTS module. File
decomposition:

| File | Role | TTS analogue |
|------|------|--------------|
| `hardcover-client.service.ts` | `fetch` with retry / backoff / 429 handling, `sanitizeLogValue` logging | `tts-client.service.ts` — HTTP to sidecar |
| `hardcover-queue.service.ts` | per-user throttle | `tts-queue.service.ts` — limit concurrency to protect the CPU sidecar |
| `hardcover-auto-sync-scheduler.service.ts` | debounced async scheduling, in-flight tracking | conversion job runner |
| `hardcover-settings.service.ts` | per-user config persistence | per-user voice/speed prefs |
| `hardcover.repository.ts` | DB access | job/status rows |
| `hardcover.controller.ts` | REST | `POST /tts/convert/:bookId`, `GET /tts/jobs/:id` |

Uses the global `fetch`, no extra HTTP lib.

### 1.6 File-write layer (`server/src/modules/file-write/`)

- `FileLockService.withLock(path, fn)` — per-path serialization.
- `FileRenameService` — writes/renames library files, debounced, with
  rollback and `NotificationService` integration.
- `formats/` + `format-writer.registry.ts` — a pluggable format-writer
  registry. A generated-audio writer can register here.

**Implication for Mode B:** writing the produced M4B into the book's directory
alongside existing files is a solved path, including locking so it doesn't
collide with renames/scans.

### 1.7 Config & env

- Configs are `registerAs(...)` factories in `server/src/config/config.ts`,
  loaded in `app.module.ts`.
- Env is validated by a zod schema in `server/src/config/env.validation.ts`.
- `.env.example` documents each var (see `OIDC_ALLOW_LOCAL_ISSUERS` for the
  optional-feature precedent).

### 1.8 Container model (`docker-compose.yml`)

- `app` is `read_only: true` with `tmpfs: /tmp`, caps dropped, volumes
  `${BOOKS_HOST_PATH}:/books` (RW) and `./data/app:/data` (RW).
- `postgres` is a sibling service on the compose network.

So generated audio is written to the **RW `/books` or `/data` volume**, not
the read-only rootfs. A `pocket-tts` sidecar joins the same network and is
addressable as `http://pocket-tts:<port>`.

---

## 2. Two integration modes

### Mode A — Live reader read-aloud (ship first, smallest scope)

**Flow:**

1. New composable `client/src/features/reader/epub/composables/useTts.ts`
   instantiates foliate's `TTS` against the current view's document.
2. `tts.start()` → the first block's SSML; strip to plain text (the API takes
   text, not SSML).
3. POST `{ input: text, voice }` → NestJS proxy `POST /api/v1/tts/synthesize`
   (proxies to the sidecar so the browser never sees the sidecar origin / no
   CSP edit needed). Response is a **streaming WAV**.
4. Feed the WAV stream to an `<audio>` element: either collect the block's
   stream into a `Blob` → `URL.createObjectURL` (simplest; small per-block
   latency) or pipe via `MediaSource` (lower latency, more code). On `ended`,
   `tts.next()` and repeat.
5. Wire `tts.setMark(mark)` to the `overlayer` to **highlight the current
   block** being spoken (block-level, not word-level — PocketTTS returns no
   word timestamps).
6. Controls: play/pause, skip block prev/next, stop, voice picker
   (`GET /api/v1/tts/voices`). Note: `speed` is accepted by the API but
   **ignored** server-side; expose playback-rate on the `<audio>` element
   instead.

**Server surface:** two thin proxies (`/api/v1/tts/synthesize`,
`/api/v1/tts/voices`). Minimal. **No DB, no async job.** The sidecar is the
only stateful dependency.

### Mode B — Async eBook → audiobook conversion

**Flow:**

1. `POST /api/v1/tts/convert/:bookId` (user-scoped) enqueues a job.
2. `TtsService` resolves the book's primary EPUB file via `BookReadService`
   and the library path.
3. `EpubService` (extended with a `extractText(bookId, fileId, user)`)
   yields spine XHTML in reading order; strip tags → text chunks
   (≤ `TTS_MAX_CHUNK_CHARS`).
4. `TtsClientService` POSTs each chunk to the sidecar, collects audio.
5. Stitch segments → M4B (ffmpeg with chapter metadata from the EPUB TOC) or
   MP3. Persist progress per-chapter in a `tts_jobs` table so it's resumable.
6. `FileWriteService`/`FileLockService` writes the file into the book
   directory; insert a `book_files` row (or let the scanner pick it up).
7. On completion: `NotificationService.notify({ type:'tts.conversion_complete',
   scope:{kind:'user',userId}, actionUrl:'/books/<id>', meta:{bookId,fileId} })`
   → instant WebSocket push + persisted bell item.
8. On failure: notify with `tts.conversion_failed` + error in `meta`.

**Resumability/long jobs:** a 300-page book is hours of audio. Chunk by spine
item, persist per-chunk status, make `TtsQueueService` concurrency-limit
(default 1) so the sidecar isn't flooded. Mirror
`HardcoverAutoSyncSchedulerService`'s in-flight/debounce discipline.

---

## 3. Docker sidecar

Add to **both** `docker-compose.yml` and `docker-compose.dev.yml`.

> **No official Docker image exists** — `pocket-tts-deno` is a Deno app with
> no `Dockerfile`. Author a small one (Deno base image + copy source + the
> ~190 MB of ONNX models / `voices.bin` / `tokenizer.model` /
> `sentencepiece.wasm`). The models are large; bake them into the image or
> mount them as a volume.

```yaml
  pocket-tts:
    container_name: bookorbit-pocket-tts
    build: ./docker/pocket-tts        # or image: ghcr.io/<you>/pocket-tts-deno:tag
    restart: unless-stopped
    ports:
      - "127.0.0.1:${POCKET_TTS_PORT:-8001}:8000"   # loopback only; app talks over the compose net
    # CPU-only ONNX (INT8). No GPU passthrough needed.
    volumes:
      - pocket-tts-models:/models       # bake or mount the ONNX models here
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8000/health"]  # 200 ready / 503 loading
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 60s
```

`app` gets `depends_on: { pocket-tts: { condition: service_healthy } }`. Inside
the network the sidecar is `http://pocket-tts:8000`.

For **dev** (where `app` runs on host, not in compose), point
`POCKET_TTS_URL=http://localhost:8001` so the host NestJS can reach the
published port.

---

## 4. Config & env

Add to `server/src/config/config.ts`:

```ts
export const ttsConfig = registerAs('tts', () => ({
  enabled: parseBooleanFlag(process.env.TTS_ENABLED, false),
  pocketTtsUrl: process.env.POCKET_TTS_URL ?? 'http://pocket-tts:8000',
  requestTimeoutMs: parsePositiveInteger(process.env.TTS_REQUEST_TIMEOUT_MS, 30_000),
  maxChunkChars: parsePositiveInteger(process.env.TTS_MAX_CHUNK_CHARS, 3000),
  maxConcurrentJobs: parsePositiveInteger(process.env.TTS_MAX_CONCURRENT_JOBS, 1),
  defaultVoice: process.env.TTS_DEFAULT_VOICE ?? undefined,
}));
```

Load `ttsConfig` in `app.module.ts`; add matching optional fields to the zod
schema in `env.validation.ts`; document in `.env.example`:

```dotenv
# PocketTTS sidecar (optional). Disabled by default.
TTS_ENABLED=false
POCKET_TTS_URL=http://pocket-tts:8000
# TTS_REQUEST_TIMEOUT_MS=30000
# TTS_MAX_CHUNK_CHARS=3000
# TTS_MAX_CONCURRENT_JOBS=1
# TTS_DEFAULT_VOICE=
```

Add a new `NotificationType` (`tts.conversion_complete`,
`tts.conversion_failed`) to `@bookorbit/types` and the notification-category
map.

---

## 5. Risks & mitigations

| Risk | Detail | Mitigation |
|------|--------|------------|
| **API confirmed — plain text in** | PocketTTS accepts **plain text**, not SSML (confirmed in `server.ts:handleSpeech`). | Strip foliate's SSML wrapper to plain text per block (`tts.#speak(doc)` without the mark-getter serializes plain text). Keep the mark `Range`s client-side for block highlighting. |
| **No word timestamps** | PocketTTS streams WAV only; no per-word timing returned. | Highlight at **block level** (current spoken block via `setMark`), not word-level karaoke. Word-sync would need forced-alignment (out of scope). |
| **No official Docker image** | `pocket-tts-deno` ships source only; ~190 MB of ONNX models + wasm. | Author a `docker/pocket-tts/Dockerfile` (Deno base) baking in models, or mount them as a volume. |
| **CPU-only, slow** | INT8 ONNX on CPU; a single request saturates cores and may run slower than realtime for long text. No GPU option in this port. | `TtsQueueService` concurrency default **1**; chunk by spine item; persist progress; surface queue position in notification `meta`. For Mode A, stream per-block so the user hears the first block while later ones generate. |
| **`speed` ignored / no language param** | `server.ts` accepts `speed` and `response_format` for OpenAI-compat but ignores both; voice selects timbre, not language. | Expose playback-rate on the client `<audio>` element instead of server `speed`. Language follows the model (kyutai pocket-tts is multilingual); don't expose a language picker unless verified. |
| **Voice cloning is in-memory** | `POST /v1/voices` stores embeddings in RAM; lost on sidecar restart. | Treat custom voices as ephemeral Phase 3; persisting them is a sidecar enhancement, not BookOrbit's concern initially. |
| **Long conversion jobs** | 300-page book = hours of audio; HTTP timeouts, crashes mid-run. | Chunk by spine item; persist per-chunk status in `tts_jobs`; resumable; concurrency-limit the queue. |
| **Read-only container** | `app` is `read_only: true` + `tmpfs:/tmp`. | Write generated audio to the RW `/books` or `/data` volume via `FileWriteService`, never the rootfs. |
| **Browser CSP** | Direct browser→sidecar calls blocked by app CSP (sidecar CORS is open, but CSP still blocks). | Proxy TTS through NestJS (`/api/v1/tts/synthesize`, `/api/v1/tts/voices`). |
| **Audio stitching deps** | M4B muxing/chaptering needs ffmpeg in the app image. | Confirm ffmpeg is in the app image, or stitch WAV→M4B inside the `pocket-tts` container, or emit concatenated WAV/MP3 segments instead. |
| **Library scanner collision** | Writing a new file while a scan runs. | Use `FileLockService.withLock('book:'+bookId, …)`. |

---

## 6. Recommended phase order

1. **Spike (mostly done):** the API contract is confirmed in §8. Remaining
   spike work: build the `pocket-tts` Docker image, run it, and `curl`
   `/v1/audio/speech` end-to-end to measure **throughput** (audio-seconds per
   wall-clock-second on the target CPU) — this sets `TTS_MAX_CHUNK_CHARS` and
   the queue concurrency defaults. Write findings into `docs/POCKET_TTS_API.md`.
2. **Phase 1 — Live reader TTS:** `useTts.ts` composable, two NestJS proxy
   endpoints, dev-compose sidecar. Highest user value, smallest scope.
3. **Phase 2 — Async conversion:** `server/src/modules/tts/` module (Hardcover
   pattern), EPUB text extraction, audio stitching, `NotificationService`
   completion push, scanner/file-write integration.
4. **Phase 3 — Polish:** per-user voice settings (incl. custom-voice upload),
   live progress via WebSocket, retry failed chapters, multi-voice, OPDS
   exposure of generated audiobooks.

---

## 7. New files / touchpoints (preview, not started)

**Server:**
- `server/src/modules/tts/tts.module.ts`
- `server/src/modules/tts/tts.controller.ts` — `POST /tts/convert/:bookId`, `GET /tts/jobs/:id`, `POST /api/v1/tts/synthesize` (proxy)
- `server/src/modules/tts/tts.service.ts` — orchestration
- `server/src/modules/tts/tts-client.service.ts` — sidecar HTTP (single contract surface)
- `server/src/modules/tts/tts-queue.service.ts` — concurrency
- `server/src/modules/tts/tts.repository.ts` — job/status rows
- `server/src/modules/reader/epub/epub.service.ts` — add `extractText(...)`
- `server/src/config/config.ts` + `env.validation.ts` + `app.module.ts` — `ttsConfig`
- `packages/types` — `NotificationType` additions

**Client:**
- `client/src/features/reader/epub/composables/useTts.ts` — foliate TTS → sidecar → audio playback + highlight
- `client/src/features/reader/epub/components/TtsControls.vue` — play/pause/skip/voice
- `client/src/features/reader/ReaderView.vue` — wire `useTts` + controls button
- book detail action: "Convert to audiobook" button → `POST /api/v1/tts/convert/:bookId`

**Infra:**
- `docker-compose.yml`, `docker-compose.dev.yml` — `pocket-tts` service
- `docker/pocket-tts/Dockerfile` — Deno base + models (none shipped upstream)
- `.env.example` — TTS_* vars
- `docs/POCKET_TTS_API.md` — recorded sidecar throughput benchmarks (from spike)

---

## 8. Confirmed PocketTTS API contract

Source: [`bytetrie/pocket-tts-deno`](https://github.com/bytetrie/pocket-tts-deno)
`server.ts` (read directly). Deno HTTP server, CPU-only ONNX (INT8), kyutai
pocket-tts models. No GPU, no cloud, no auth.

### `POST /v1/audio/speech` — synthesize

**Request:** JSON body

| Field | Type | Default | Behaviour |
|-------|------|---------|-----------|
| `input` | string | required | **Plain text** (the server preprocesses numbers/unicode to ASCII speech text; chunks internally at ≤50 SentencePiece tokens). No max length enforced server-side. |
| `voice` | string | `"cosette"` | Built-in (`cosette`, `jean`, `fantine`) or a registered custom voice id. Unknown voice → `400`. |
| `speed` | number | `1.0` | **Accepted but ignored.** |
| `response_format` | string | `"wav"` | **Accepted but ignored** — always WAV. |

**Response:** `200`, `Content-Type: audio/wav`, `Transfer-Encoding: chunked`,
24 kHz mono PCM16. WAV header written immediately with streaming placeholder
size (`0xFFFFFFFF`); audio is appended frame-by-frame as generation proceeds
(progressively playable / appendable). `503` if models still loading.

### `GET /v1/voices` — list voices

`{ "voices": [...], "builtin": [...], "custom": [...] }`

### `POST /v1/voices?name=<id>` — register custom voice (cloning)

Body: multipart `file=@sample.wav` **or** raw `audio/wav` bytes. Constraints:
truncated to **10 s**, stereo→mono, any sample rate resampled to 24 kHz, WAV
only (PCM16/PCM32/IEEE float). Returns `201 { id, frames, status:"ready" }`.
**Embeddings + conditioned KV-cache are in-memory only — lost on restart.**

### `DELETE /v1/voices/:name` — remove custom voice

Built-in voices cannot be deleted.

### `GET /health` — readiness

`200` when models loaded, `503` while loading.

### `GET /` — server info + endpoint summary

### Cross-cutting

- **CORS open** on every response (`corsHeaders()`), but BookOrbit's app CSP
  still blocks direct browser→sidecar calls → proxy through NestJS.
- **No auth** — rely on loopback port binding + compose-internal network.
- **No language parameter** — language follows the model/voice, not a request
  field. The `speed`/`response_format` fields exist only for OpenAI-API shape
  compatibility and are no-ops.
- **Streaming WAV with unknown length** — clients that demand a known size
  (some M4B muxers) must buffer the full stream first.
