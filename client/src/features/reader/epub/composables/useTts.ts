import { computed, onUnmounted, ref, watch } from 'vue'
import { api } from '@/lib/api'

/**
 * Minimal interface of the foliate `<foliate-view>` element the composable
 * touches. The full element is typed in {@link useFoliate}; we keep the
 * surface narrow so this composable is easy to test without foliate.
 */
export interface FoliateTtsView {
  initTTS?: (granularity?: string, highlight?: unknown) => Promise<void>
  tts?: {
    start?: () => string
    next?: () => string
    prev?: () => string
    resume?: () => string
    /** Begin narrating from the block containing `range` (current view pos). */
    from?: (range: Range) => string
  }
  /** Advance the renderer to a section (number arg = section index). */
  goTo?: (target: string | number) => Promise<unknown>
  addEventListener?: (type: string, handler: EventListenerOrEventListenerObject) => void
  removeEventListener?: (type: string, handler: EventListenerOrEventListenerObject) => void
  /** Set by foliate's `relocate` handler; carries the current view Range. */
  lastLocation?: { range?: Range } | null
}

export interface TtsStatusResponse {
  enabled: boolean
  reachable: boolean
  /** Effective per-request input cap reported by the proxy (assertCap value). */
  maxChunkChars?: number
}

/** Sidecar voice list shape (`GET /v1/voices` — see docs/POCKET_TTS_API.md). */
export interface TtsVoicesResponse {
  /** Flat list of every available voice id (built-in + custom). */
  voices: string[]
  builtin: string[]
  custom: string[]
}

export interface TtsOptions {
  /** Feed the reading session (read-aloud counts as reading — see ADR-0002). */
  onActivity?: () => void
  /** Called once when narration reaches the end of the book. */
  onEndOfBook?: () => void
  /** Current section index (0-based), used to compute the next section. */
  getSectionIndex?: () => number
  /** Total number of sections, used to detect end of book. */
  getTotalSections?: () => number
  /** Override the per-request character cap (default 4000, matches the proxy). */
  maxChunkChars?: number
  /**
   * How many upcoming blocks to synthesise ahead of the one playing. The
   * sidecar processes one job at a time (`TTS_MAX_CONCURRENT_JOBS=1`), so the
   * prefetch fan-out keeps it zero-idle — the next request is already queued
   * the instant the current finishes, hiding the network/JS gap that a
   * sequential prefetch would reintroduce. Deeper buffers smooth short-block
   * lag at the cost of up to `prefetchDepth` discarded blobs on stop/skip.
   * Default 3.
   */
  prefetchDepth?: number
}

/** One synthesizable unit: either already a Blob (prefetched) or text to send. */
interface Chunk {
  text: string
  blob: Blob | null
}

const ACTIVITY_TICK_MS = 30_000
/** Default number of upcoming blocks to keep warm in the prefetch queue. */
const DEFAULT_PREFETCH_DEPTH = 3

/**
 * Strip foliate's W3C SSML wrapper to the plain text the PocketTTS API expects.
 * The PocketTTS API takes plain text (not SSML); the `<mark>`/`<break>`/
 * `<emphasis>` elements foliate inserts carry no text content, so reading the
 * `<speak>` element's `textContent` yields the block's plain text.
 */
export function ssmlToPlainText(ssml: string): string {
  if (!ssml) return ''
  const doc = new DOMParser().parseFromString(ssml, 'application/xml')
  // If parsing failed (no root, or a <parsererror> root), fall back to the raw
  // string with any tags stripped rather than emitting the parse error text.
  const root = doc.documentElement
  if (!root || root.localName === 'parsererror') return ssml.replace(/<[^>]+>/g, '')
  return root.textContent ?? ''
}

/**
 * Split an overlong block into chunks under the proxy's per-request cap, on
 * sentence boundaries where possible. A single sentence longer than the cap is
 * hard-split on word boundaries. Falls back to a plain character split when the
 * input has no sentence punctuation.
 */
export function splitBlock(text: string, maxChars = 4000): string[] {
  if (text.length <= maxChars) return [text]

  const sentenceRegex = /[^.!?]+[.!?]+["')\]]*(?:\s+|$)|[^.!?]+$/g
  const chunks: string[] = []
  let current = ''
  let match: RegExpExecArray | null
  while ((match = sentenceRegex.exec(text)) !== null) {
    const sentence = match[0]
    if (current && current.length + sentence.length > maxChars) {
      chunks.push(current)
      current = ''
    }
    if (sentence.length > maxChars) {
      if (current) {
        chunks.push(current)
        current = ''
      }
      // Hard-split an overlong sentence on word boundaries; a single word
      // longer than the cap is split by character.
      for (const word of sentence.split(/(\s+)/)) {
        if (word.trim() === '') {
          if (current) current += word
          continue
        }
        if (word.length > maxChars) {
          if (current) {
            chunks.push(current)
            current = ''
          }
          for (let i = 0; i < word.length; i += maxChars) chunks.push(word.slice(i, i + maxChars))
        } else if (current && current.length + word.length > maxChars) {
          chunks.push(current)
          current = word
        } else {
          current += word
        }
      }
    } else {
      current += sentence
    }
    // Guard against a zero-length infinite loop on pathological input.
    if (match.index === sentenceRegex.lastIndex) sentenceRegex.lastIndex++
  }
  if (current) chunks.push(current)
  return chunks.length ? chunks : hardSplit(text, maxChars)
}

function hardSplit(text: string, maxChars: number): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += maxChars) out.push(text.slice(i, i + maxChars))
  return out
}

/**
 * Continuous read-aloud: drive a block cursor across a section (and into the
 * next), prefetch one block ahead, split overlong blocks, and feed the reading
 * session. See issue #3.
 */
export function useTts(getView: () => FoliateTtsView | null, options: TtsOptions = {}) {
  const isPlaying = ref(false)
  const isLoading = ref(false)
  const statusEnabled = ref(false)
  const statusReachable = ref(false)
  const statusMaxChunkChars = ref<number | null>(null)
  const error = ref<string | null>(null)

  /** Selected Voice (a synthetic timbre per CONTEXT.md — never a Narrator); null = sidecar default. */
  const voice = ref<string | null>(null)
  /** Client-side playback rate applied to the <audio> element (0.75×–2×); the sidecar accepts but ignores `speed`. */
  const playbackRate = ref(1)
  /** Raw sidecar voice list, split into built-in and custom groups for the picker. */
  const voicesRaw = ref<TtsVoicesResponse | null>(null)
  const builtinVoices = computed(() => voicesRaw.value?.builtin ?? [])
  const customVoices = computed(() => voicesRaw.value?.custom ?? [])
  /** True while narration is paused mid-block (distinct from idle/stopped, which can only start fresh). */
  const isPaused = ref(false)

  const onActivity = options.onActivity
  const onEndOfBook = options.onEndOfBook
  const getSectionIndex = options.getSectionIndex
  const getTotalSections = options.getTotalSections

  let audio: HTMLAudioElement | null = null
  let audioWired = false
  let objectUrl: string | null = null
  let controller: AbortController | null = null
  let prefetchController: AbortController | null = null
  let activityInterval: ReturnType<typeof setInterval> | null = null

  /** Remaining chunks of the block currently being played (text or blob-backed). */
  let currentChunks: Chunk[] = []
  /** FIFO of upcoming blocks, each synthesised in its own in-flight promise. */
  const prefetchQueue: Promise<Chunk[] | null>[] = []
  /** True once the prefetch cursor reached the end of the current section. */
  let sectionExhausted = false
  /** Optional floor for the per-request cap (default 4000, matches the proxy hard cap). */
  const maxChunkChars = options.maxChunkChars ?? 4000
  /** Number of upcoming blocks to keep synthesised ahead of the current block. */
  const prefetchDepth = Math.max(1, options.prefetchDepth ?? DEFAULT_PREFETCH_DEPTH)
  /**
   * How many blocks the foliate TTS cursor sits ahead of the block currently
   * playing — the number of `tts.next()` calls whose blocks still sit in the
   * prefetch queue (end-of-section sentinels excluded, since they don't move
   * the cursor). Drives {@link skipPrev}'s cursor math without a block index.
   */
  let prefetchAhead = 0

  /**
   * The effective per-request character cap. Prefers the live value reported by
   * the proxy's `/status` (so a lowered `TTS_MAX_CHUNK_CHARS` config is respected
   * without a redeploy of the client); falls back to the configured floor when
   * the proxy hasn't been probed yet. This keeps client-side splitting synced
   * with server-side `assertCap`, so overlong blocks are never rejected as 400.
   */
  function effectiveCap(): number {
    return Math.min(maxChunkChars, statusMaxChunkChars.value ?? maxChunkChars)
  }

  let stopped = true
  let advancing = false
  let loadListener: EventListener | null = null
  let loadTimeout: ReturnType<typeof setTimeout> | null = null

  async function checkAvailability(): Promise<void> {
    try {
      const res = await api('/api/v1/tts/status')
      if (!res.ok) {
        statusEnabled.value = false
        statusReachable.value = false
        return
      }
      const data = (await res.json()) as TtsStatusResponse
      statusEnabled.value = data.enabled
      statusReachable.value = data.reachable
      statusMaxChunkChars.value = typeof data.maxChunkChars === 'number' && data.maxChunkChars > 0 ? data.maxChunkChars : null
    } catch {
      statusEnabled.value = false
      statusReachable.value = false
      statusMaxChunkChars.value = null
    }
  }

  /** Populate the Voice picker from `GET /api/v1/tts/voices`. Fails silently — the picker just stays empty. */
  async function fetchVoices(): Promise<void> {
    try {
      const res = await api('/api/v1/tts/voices')
      if (!res.ok) return
      const data = (await res.json()) as TtsVoicesResponse
      if (data && Array.isArray(data.voices)) voicesRaw.value = data
    } catch {
      // sidecar down / no permission — picker stays empty, feature still works with the sidecar default
    }
  }

  function ensureAudio(): HTMLAudioElement {
    if (!audio) audio = new Audio()
    if (!audioWired) {
      audio.addEventListener('ended', () => {
        if (stopped) return
        if (advancing) return
        advancing = true
        void advance().finally(() => {
          advancing = false
        })
      })
      audio.addEventListener('pause', () => {
        if (stopped) isPlaying.value = false
      })
      audio.addEventListener('play', () => {
        if (!stopped) isPlaying.value = true
      })
      audioWired = true
    }
    audio.playbackRate = playbackRate.value
    return audio
  }

  function resetPlayback(): void {
    stopped = true
    advancing = false
    if (audio) {
      audio.pause()
      audio.src = ''
    }
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl)
      objectUrl = null
    }
    if (controller) {
      controller.abort()
      controller = null
    }
    if (prefetchController) {
      prefetchController.abort()
      prefetchController = null
    }
    if (activityInterval) {
      clearInterval(activityInterval)
      activityInterval = null
    }
    if (loadListener) {
      getView()?.removeEventListener?.('load', loadListener)
      loadListener = null
    }
    if (loadTimeout) {
      clearTimeout(loadTimeout)
      loadTimeout = null
    }
    currentChunks = []
    prefetchQueue.length = 0
    sectionExhausted = false
    prefetchAhead = 0
    isPaused.value = false
    isPlaying.value = false
    isLoading.value = false
  }

  async function synthesizeBlock(text: string, signal: AbortSignal): Promise<Blob> {
    const res = await api('/api/v1/tts/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text, voice: voice.value ?? undefined }),
      signal,
    })
    if (res.status === 503) {
      throw new Error('Read aloud is unavailable right now.')
    }
    if (!res.ok) {
      throw new Error(`Read aloud failed (${res.status}).`)
    }
    return res.blob()
  }

  function feedActivity(): void {
    if (stopped) return
    onActivity?.()
  }

  function startActivityInterval(): void {
    if (activityInterval || !onActivity) return
    activityInterval = setInterval(() => feedActivity(), ACTIVITY_TICK_MS)
  }

  /** Synthesise (if needed) and play a single chunk; wires the audio element. */
  async function playChunk(chunk: Chunk): Promise<void> {
    let blob = chunk.blob
    if (!blob) {
      controller = new AbortController()
      blob = await synthesizeBlock(chunk.text, controller.signal)
      chunk.blob = blob
    }
    if (stopped) return
    const el = ensureAudio()
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    objectUrl = URL.createObjectURL(blob)
    el.src = objectUrl
    el.playbackRate = playbackRate.value
    await el.play()
  }

  /**
   * Synthesise one block's text into a ready-to-play chunk list. Runs as an
   * in-flight promise; on abort it resolves `null` (treated as a skip), on any
   * other error it surfaces the message and halts playback.
   */
  function synthesizeBlockPromise(ssml: string): Promise<Chunk[] | null> {
    return (async (): Promise<Chunk[] | null> => {
      const text = ssmlToPlainText(ssml).trim()
      if (!text) return null // empty block → behaves like an end-of-section marker
      const chunks: Chunk[] = splitBlock(text, effectiveCap()).map((t) => ({ text: t, blob: null }))
      const signal = prefetchController!.signal
      for (const chunk of chunks) {
        if (signal.aborted) return null
        chunk.blob = await synthesizeBlock(chunk.text, signal)
      }
      return chunks
    })().catch((err) => {
      if ((err as Error)?.name === 'AbortError') return null
      if (!stopped) {
        error.value = err instanceof Error ? err.message : 'Read aloud failed.'
        resetPlayback()
      }
      return null
    })
  }

  /**
   * Keep the prefetch queue topped up to `prefetchDepth` upcoming blocks.
   * The foliate TTS cursor advances synchronously here (one `tts.next()` per
   * block), and each block's synthesis fires as its own in-flight promise so
   * the sidecar — which processes one job at a time — stays zero-idle: the
   * next request is already queued the instant the current finishes. When the
   * cursor reaches the end of the section, a resolved-`null` sentinel is queued
   * and `sectionExhausted` is set so we stop topping up until the next section.
   */
  function topUpPrefetch(): void {
    if (sectionExhausted) return
    const view = getView()
    const tts = view?.tts
    if (!tts?.next) return
    if (!prefetchController) prefetchController = new AbortController()
    while (prefetchQueue.length < prefetchDepth && !sectionExhausted) {
      const ssml = tts.next!() ?? ''
      if (!ssml) {
        prefetchQueue.push(Promise.resolve(null))
        sectionExhausted = true
        break
      }
      prefetchQueue.push(synthesizeBlockPromise(ssml))
      prefetchAhead++
    }
  }

  /** Advance the cursor one block: next chunk, next block, or next section. */
  async function advance(): Promise<void> {
    if (stopped) return
    // Remaining chunks of the current block: just-in-time synthesis.
    if (currentChunks.length > 0) {
      const chunk = currentChunks.shift()!
      try {
        await playChunk(chunk)
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return
        error.value = err instanceof Error ? err.message : 'Read aloud failed.'
        resetPlayback()
      }
      return
    }

    // Current block exhausted → pull the next prefetched block (FIFO) or the
    // end-of-section sentinel off the front of the queue.
    let next: Promise<Chunk[] | null> | null = prefetchQueue.shift() ?? null
    if (!stopped && !next) {
      // Queue drained faster than it was topped (short blocks). Refill, then
      // retry — a top-up is synchronous and may add a sentinel.
      topUpPrefetch()
      next = prefetchQueue.shift() ?? null
    }
    if (stopped) return
    if (!next) {
      await advanceSection()
      return
    }

    let prefetched: Chunk[] | null = null
    try {
      prefetched = await next
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      error.value = err instanceof Error ? err.message : 'Read aloud failed.'
      resetPlayback()
      return
    }
    if (stopped) return

    if (!prefetched || prefetched.length === 0) {
      // Sentinel resolved: the section's blocks are exhausted.
      await advanceSection()
      return
    }

    // Cue the prefetched block as current and start it; feed the session.
    prefetchAhead = Math.max(0, prefetchAhead - 1)
    currentChunks = prefetched
    try {
      await playChunk(currentChunks.shift()!)
      feedActivity()
      topUpPrefetch()
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      error.value = err instanceof Error ? err.message : 'Read aloud failed.'
      resetPlayback()
    }
  }

  /** Cross a section boundary: renderer advance → load → re-init TTS → continue. */
  async function advanceSection(): Promise<void> {
    // Cancel any prefetch still running for the section we just finished.
    if (prefetchController) {
      prefetchController.abort()
      prefetchController = null
    }
    prefetchQueue.length = 0
    sectionExhausted = false
    prefetchAhead = 0

    const view = getView()
    if (!view?.goTo || !view?.addEventListener) {
      stopAtEndOfBook()
      return
    }
    const currentIndex = getSectionIndex?.() ?? 0
    const total = getTotalSections?.() ?? 0
    if (total && currentIndex >= total - 1) {
      stopAtEndOfBook()
      return
    }

    // The guard above proved these exist; capture them so the narrowing
    // survives into the Promise executor closure below.
    const addLoadListener = view.addEventListener!.bind(view)
    const removeLoadListener = view.removeEventListener!.bind(view)
    const goTo = view.goTo!

    const loaded = await new Promise<boolean>((resolve) => {
      const handler: EventListener = (e: Event) => {
        const detail = (e as CustomEvent).detail
        // Ignore loads for a different (skipped) section; keep waiting for ours.
        if (detail && typeof detail.index === 'number' && detail.index !== currentIndex + 1) return
        removeLoadListener('load', handler)
        loadListener = null
        if (loadTimeout) {
          clearTimeout(loadTimeout)
          loadTimeout = null
        }
        resolve(true)
      }
      loadListener = handler
      addLoadListener('load', handler)

      loadTimeout = setTimeout(() => {
        removeLoadListener('load', handler)
        loadListener = null
        resolve(false)
      }, 15_000)

      Promise.resolve(goTo(currentIndex + 1)).catch(() => {
        removeLoadListener('load', handler)
        loadListener = null
        if (loadTimeout) clearTimeout(loadTimeout)
        resolve(false)
      })
    })

    if (stopped) return
    if (!loaded) {
      stopAtEndOfBook()
      return
    }

    // New document loaded: re-initialise TTS for its DOM and start at block 0.
    try {
      await view.initTTS?.()
      const ssml = view.tts?.start?.() ?? ''
      const text = ssmlToPlainText(ssml).trim()
      if (!text) {
        // Empty section → treat as end of book (keeps this slice simple).
        stopAtEndOfBook()
        return
      }
      currentChunks = splitBlock(text, effectiveCap()).map((t) => ({ text: t, blob: null }))
      await playChunk(currentChunks.shift()!)
      feedActivity()
      topUpPrefetch()
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      stopAtEndOfBook()
    }
  }

  function stopAtEndOfBook(): void {
    const wasPlaying = isPlaying.value
    resetPlayback()
    if (wasPlaying) onEndOfBook?.()
  }

  /** Begin continuous narration from the current view position. */
  async function readAloud(): Promise<void> {
    const view = getView()
    if (!view?.initTTS?.call) {
      error.value = 'Reader is not ready yet.'
      return
    }
    resetPlayback()
    error.value = null
    stopped = false
    isLoading.value = true

    try {
      await view.initTTS()

      const tts = view.tts
      let ssml = ''
      const range = view.lastLocation?.range
      if (range && tts?.from) {
        ssml = tts.from(range) ?? ''
      } else {
        ssml = tts?.start?.() ?? ''
      }
      const text = ssmlToPlainText(ssml).trim()
      if (!text) {
        error.value = 'No readable text on this page.'
        resetPlayback()
        return
      }

      currentChunks = splitBlock(text, effectiveCap()).map((t) => ({ text: t, blob: null }))
      startActivityInterval()
      await playChunk(currentChunks.shift()!)
      feedActivity()
      topUpPrefetch()
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      error.value = err instanceof Error ? err.message : 'Read aloud failed.'
      resetPlayback()
    } finally {
      isLoading.value = false
    }
  }

  function stop(): void {
    resetPlayback()
  }

  /** Pause narration in place — keep the cursor/prefetch, just halt the audio and stop feeding the session. */
  function pause(): void {
    if (stopped || !audio) return
    isPaused.value = true
    if (activityInterval) {
      clearInterval(activityInterval)
      activityInterval = null
    }
    audio.pause()
    isPlaying.value = false
  }

  /** Resume a paused narration from where it stopped. */
  function resume(): void {
    if (stopped || !audio) return
    isPaused.value = false
    void audio.play()
    startActivityInterval()
  }

  /** Jump to the next block: discard the rest of the current block and pull the already-prefetched next one. */
  async function skipNext(): Promise<void> {
    if (stopped || advancing) return
    advancing = true
    try {
      if (audio) audio.pause()
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
        objectUrl = null
      }
      if (controller) {
        controller.abort()
        controller = null
      }
      currentChunks = []
      isPaused.value = false // resume-on-skip: clear a mid-block pause.
      await advance()
    } finally {
      advancing = false
    }
  }

  /** Jump back one block by walking foliate's cursor backwards, then re-synthesise + play. */
  async function skipPrev(): Promise<void> {
    if (stopped || advancing) return
    const view = getView()
    if (!view?.tts?.prev) return
    const tts = view.tts!
    advancing = true
    isLoading.value = true
    try {
      // Cancel the current block + in-flight prefetch, keeping the foliate cursor.
      if (audio) audio.pause()
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl)
        objectUrl = null
      }
      if (controller) {
        controller.abort()
        controller = null
      }
      if (prefetchController) {
        prefetchController.abort()
        prefetchController = null
      }
      prefetchQueue.length = 0
      currentChunks = []
      sectionExhausted = false
      isPlaying.value = false
      isPaused.value = false

      // The cursor sits `prefetchAhead` blocks ahead of the playing block, so
      // `prefetchAhead + 1` prev() calls lands on the previous block. An empty
      // result means we hit the start of the section — fall back to re-reading
      // block 0.
      const steps = prefetchAhead + 1
      let ssml = ''
      for (let i = 0; i < steps; i++) {
        const s = tts.prev!() ?? ''
        if (!s) {
          ssml = ''
          break
        }
        ssml = s
      }
      if (!ssml) {
        await view.initTTS?.()
        ssml = tts.start?.() ?? ''
      }
      prefetchAhead = 0

      const text = ssmlToPlainText(ssml).trim()
      if (!text) {
        resetPlayback()
        return
      }
      currentChunks = splitBlock(text, effectiveCap()).map((t) => ({ text: t, blob: null }))
      prefetchController = new AbortController()
      startActivityInterval()
      try {
        await playChunk(currentChunks.shift()!)
        feedActivity()
        topUpPrefetch()
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return
        error.value = err instanceof Error ? err.message : 'Read aloud failed.'
        resetPlayback()
      }
    } finally {
      isLoading.value = false
      advancing = false
    }
  }

  /** Smart play/pause: the Alt+P shortcut and the popover toggle button both call this. */
  function toggle(): void {
    if (isLoading.value) {
      stop()
      return
    }
    if (isPlaying.value) {
      pause()
      return
    }
    if (isPaused.value && audio) {
      resume()
      return
    }
    void readAloud()
  }

  // Apply a live speed change to the already-playing audio element.
  watch(playbackRate, (rate) => {
    if (audio) audio.playbackRate = rate
  })

  onUnmounted(() => resetPlayback())

  return {
    isPlaying,
    isLoading,
    isPaused,
    statusEnabled,
    statusReachable,
    statusMaxChunkChars,
    voice,
    playbackRate,
    builtinVoices,
    customVoices,
    error,
    checkAvailability,
    fetchVoices,
    readAloud,
    stop,
    pause,
    resume,
    skipNext,
    skipPrev,
    toggle,
  }
}
