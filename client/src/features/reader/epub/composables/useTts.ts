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
  }
}

export interface TtsStatusResponse {
  enabled: boolean
  reachable: boolean
}

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
 * Tracer-bullet read-aloud: synthesise a single EPUB block (block 0) through
 * the NestJS proxy and play the returned WAV blob. No prefetch, no section
 * traversal, no popover — just one block.
 */
export function useTts(getView: () => FoliateTtsView | null) {
  const isPlaying = ref(false)
  const isLoading = ref(false)
  const statusEnabled = ref(false)
  const statusReachable = ref(false)
  const error = ref<string | null>(null)

  let audio: HTMLAudioElement | null = null
  let objectUrl: string | null = null
  let controller: AbortController | null = null

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

  function resetPlayback(): void {
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
    isPlaying.value = false
    isLoading.value = false
  }

  async function synthesizeBlock(text: string, voice?: string): Promise<Blob> {
    controller = new AbortController()
    const res = await api('/api/v1/tts/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text, voice }),
      signal: controller.signal,
    })
    if (res.status === 503) {
      throw new Error('Read aloud is unavailable right now.')
    }
    if (!res.ok) {
      throw new Error(`Read aloud failed (${res.status}).`)
    }
    return res.blob()
  }

  /** Synthesise and play block 0 of the current section. */
  async function readAloud(): Promise<void> {
    const view = getView()
    if (!view?.initTTS?.call) {
      error.value = 'Reader is not ready yet.'
      return
    }
    resetPlayback()
    error.value = null
    isLoading.value = true

    try {
      await view.initTTS()

      const tts = view.tts
      const ssml = tts?.start?.() ?? ''
      const text = ssmlToPlainText(ssml).trim()
      if (!text) {
        error.value = 'No readable text on this page.'
        return
      }

      const blob = await synthesizeBlock(text)
      objectUrl = URL.createObjectURL(blob)
      audio = new Audio(objectUrl)
      audio.addEventListener('ended', () => {
        isPlaying.value = false
      })
      audio.addEventListener('pause', () => {
        isPlaying.value = false
      })
      audio.addEventListener('play', () => {
        isPlaying.value = true
      })
      await audio.play()
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
