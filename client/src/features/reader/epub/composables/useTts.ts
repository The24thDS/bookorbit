import { onUnmounted, ref } from 'vue'
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
}

/** One synthesizable unit: either already a Blob (prefetched) or text to send. */
interface Chunk {
  text: string
  blob: Blob | null
}

const ACTIVITY_TICK_MS = 30_000

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
  const error = ref<string | null>(null)

  const onActivity = options.onActivity
  const onEndOfBook = options.onEndOfBook
  const getSectionIndex = options.getSectionIndex
  const getTotalSections = options.getTotalSections
  const maxChunkChars = options.maxChunkChars ?? 4000

  let audio: HTMLAudioElement | null = null
  let audioWired = false
  let objectUrl: string | null = null
  let controller: AbortController | null = null
  let prefetchController: AbortController | null = null
  let activityInterval: ReturnType<typeof setInterval> | null = null

  /** Remaining chunks of the block currently being played (text or blob-backed). */
  let currentChunks: Chunk[] = []
  /** Next block, fully synthesised in the background while the current plays. */
  let prefetchedChunks: Chunk[] | null = null
  /** Resolves with the prefetched block (or null = end of section) when ready. */
  let prefetchPromise: Promise<Chunk[] | null> | null = null

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
    } catch {
      statusEnabled.value = false
      statusReachable.value = false
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
    prefetchedChunks = null
    prefetchPromise = null
    isPlaying.value = false
    isLoading.value = false
  }

  async function synthesizeBlock(text: string, signal: AbortSignal): Promise<Blob> {
    const res = await api('/api/v1/tts/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text }),
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
    await el.play()
  }

  /** Prefetch the next block (cursor advance) into prefetched chunks. */
  function prefetchNext(): void {
    const view = getView()
    const tts = view?.tts
    if (!tts?.next) return
    if (prefetchController) prefetchController.abort()
    prefetchController = new AbortController()
    const signal = prefetchController.signal
    prefetchPromise = (async (): Promise<Chunk[] | null> => {
      const ssml = tts.next!() ?? ''
      if (!ssml) return null // end of current section's blocks
      const text = ssmlToPlainText(ssml).trim()
      if (!text) return null
      const chunks: Chunk[] = splitBlock(text, maxChunkChars).map((t) => ({ text: t, blob: null }))
      // Synthesise every chunk now so the next block is gap-free when 'ended' fires.
      for (const chunk of chunks) {
        if (signal.aborted) return chunks
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

    // Current block exhausted → wait for the prefetched next block.
    const prefetched = prefetchPromise ? await prefetchPromise : prefetchedChunks
    if (stopped) return
    prefetchedChunks = null
    prefetchPromise = null

    if (!prefetched || prefetched.length === 0) {
      // End of the current section's blocks → cross into the next section.
      await advanceSection()
      return
    }

    // Cue the prefetched block as current and start it; feed the session.
    currentChunks = prefetched
    try {
      await playChunk(currentChunks.shift()!)
      feedActivity()
      prefetchNext()
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      error.value = err instanceof Error ? err.message : 'Read aloud failed.'
      resetPlayback()
    }
  }

  /** Cross a section boundary: renderer advance → load → re-init TTS → continue. */
  async function advanceSection(): Promise<void> {
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
      currentChunks = splitBlock(text, maxChunkChars).map((t) => ({ text: t, blob: null }))
      await playChunk(currentChunks.shift()!)
      feedActivity()
      prefetchNext()
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

      currentChunks = splitBlock(text, maxChunkChars).map((t) => ({ text: t, blob: null }))
      startActivityInterval()
      await playChunk(currentChunks.shift()!)
      feedActivity()
      prefetchNext()
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

  async function toggle(): Promise<void> {
    if (isLoading.value || isPlaying.value) {
      stop()
      return
    }
    await readAloud()
  }

  onUnmounted(() => resetPlayback())

  return {
    isPlaying,
    isLoading,
    statusEnabled,
    statusReachable,
    error,
    checkAvailability,
    readAloud,
    stop,
    toggle,
  }
}
