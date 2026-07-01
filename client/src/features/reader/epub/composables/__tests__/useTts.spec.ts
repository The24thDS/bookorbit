import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { effect } from 'vue'

import { useTts, ssmlToPlainText } from '../useTts'
import type { FoliateTtsView } from '../useTts'

// Stub the global `api` helper by mocking the module is awkward with the
// destructured import; instead we intercept fetch via the `api` shim's use of
// `fetch` and credentials. The real `api()` delegates to `fetch` with an
// Authorization header injected from a module-level token. For these tests we
// mock `@/lib/api` directly.

vi.mock('@/lib/api', () => ({
  api: vi.fn(),
}))

import { api } from '@/lib/api'

function makeView(ssml = '<speak xmlns="http://www.w3.org/2001/10/synthesis">Hello <mark name="0"/>world<mark name="1"/></speak>'): FoliateTtsView {
  return {
    initTTS: vi.fn().mockResolvedValue(undefined),
    tts: { start: vi.fn().mockReturnValue(ssml) },
  }
}

function wavBlob(): Blob {
  return new Blob(['RIFF…wav'], { type: 'audio/wav' })
}

/** Fake HTMLAudioElement that records listeners and dispatches 'play' on play(). */
function makeFakeAudio() {
  const listeners = new Map<string, EventListener[]>()
  const audio = {
    addEventListener: vi.fn((type: string, handler: EventListener) => {
      const arr = listeners.get(type) ?? []
      arr.push(handler)
      listeners.set(type, arr)
    }),
    removeEventListener: vi.fn(),
    play: vi.fn(() => {
      queueMicrotask(() => listeners.get('play')?.forEach((h) => h(new Event('play'))))
      return Promise.resolve()
    }),
    pause: vi.fn(() => {
      queueMicrotask(() => listeners.get('pause')?.forEach((h) => h(new Event('pause'))))
    }),
    src: '',
  }
  return audio
}

describe('ssmlToPlainText', () => {
  it('strips the speak wrapper and mark/break/emphasis tags to plain text', () => {
    expect(ssmlToPlainText('<speak xmlns="x">Hello <mark name="0"/>world<break/>there</speak>')).toBe('Hello worldthere')
  })

  it('returns empty string for empty input', () => {
    expect(ssmlToPlainText('')).toBe('')
  })

  it('falls back to a tag-stripped raw string if parsing yields no document element', () => {
    // A non-XML string parses to an error document with no element text.
    expect(ssmlToPlainText('not xml at all')).toBe('not xml at all')
  })
})

describe('useTts', () => {
  let urlSpy: ReturnType<typeof vi.fn>
  let revokeSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api).mockReset()
    urlSpy = vi.fn(() => 'blob:http://localhost/abc')
    revokeSpy = vi.fn()
    vi.stubGlobal('URL', { ...URL, createObjectURL: urlSpy, revokeObjectURL: revokeSpy })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('checkAvailability sets status flags from /api/v1/tts/status when enabled and reachable', async () => {
    vi.mocked(api).mockResolvedValueOnce(
      new Response(JSON.stringify({ enabled: true, reachable: true }), { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    const { statusEnabled, statusReachable, checkAvailability } = useTts(() => null)
    await checkAvailability()
    expect(statusEnabled.value).toBe(true)
    expect(statusReachable.value).toBe(true)
  })

  it('checkAvailability reports unavailable on a non-ok response', async () => {
    vi.mocked(api).mockResolvedValueOnce(new Response(null, { status: 503 }))
    const { statusEnabled, statusReachable, checkAvailability } = useTts(() => null)
    await checkAvailability()
    expect(statusEnabled.value).toBe(false)
    expect(statusReachable.value).toBe(false)
  })

  it('checkAvailability swallows fetch errors and reports unavailable', async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error('network'))
    const { statusReachable, checkAvailability } = useTts(() => null)
    await checkAvailability()
    expect(statusReachable.value).toBe(false)
  })

  it('readAloud initialises foliate TTS, strips SSML, posts block 0 plain text, and plays the WAV blob', async () => {
    const view = makeView()
    vi.mocked(api).mockResolvedValueOnce(new Response(wavBlob(), { status: 200, headers: { 'content-type': 'audio/wav' } }))

    const fakeAudio = makeFakeAudio()
    vi.stubGlobal('Audio', function AudioStub() {
      return fakeAudio
    })

    const { isLoading, isPlaying, error, readAloud, stop } = useTts(() => view)

    await readAloud()
    await Promise.resolve() // flush the dispatched 'play' event

    expect(view.initTTS).toHaveBeenCalledTimes(1)
    expect(view.tts?.start).toHaveBeenCalledTimes(1)
    // POSTed the block's plain text (mark tags stripped, leading whitespace trimmed).
    const [endpoint, init] = vi.mocked(api).mock.calls[0]
    expect(endpoint).toBe('/api/v1/tts/synthesize')
    expect(init!.method).toBe('POST')
    expect(JSON.parse(init!.body as string)).toEqual({ input: 'Hello world', voice: undefined })
    expect(fakeAudio.play).toHaveBeenCalledTimes(1)
    expect(isPlaying.value).toBe(true)
    expect(isLoading.value).toBe(false)
    expect(error.value).toBeNull()

    stop()
  })

  it('readAloud surfaces an error when there is no readable text', async () => {
    const view = makeView('') // empty SSML → no text
    const { error, readAloud } = useTts(() => view)
    await readAloud()
    expect(error.value).toBe('No readable text on this page.')
  })

  it('readAloud surfaces a 503 as "unavailable"', async () => {
    const view = makeView()
    vi.mocked(api).mockResolvedValueOnce(new Response(null, { status: 503 }))
    const { error, readAloud } = useTts(() => view)
    await readAloud()
    expect(error.value).toBe('Read aloud is unavailable right now.')
  })

  it('stop revokes the object URL and pauses playback', async () => {
    const view = makeView()
    vi.mocked(api).mockResolvedValueOnce(new Response(wavBlob(), { status: 200, headers: { 'content-type': 'audio/wav' } }))
    const fakeAudio = makeFakeAudio()
    vi.stubGlobal('Audio', function AudioStub() {
      return fakeAudio
    })

    const { readAloud, stop, isPlaying } = useTts(() => view)
    await readAloud()
    await Promise.resolve()
    stop()
    await Promise.resolve() // flush the dispatched 'pause' event
    expect(fakeAudio.pause).toHaveBeenCalled()
    expect(revokeSpy).toHaveBeenCalledWith('blob:http://localhost/abc')
    expect(isPlaying.value).toBe(false)
  })

  it('toggle stops playback if currently loading or playing', async () => {
    const view = makeView()
    vi.mocked(api).mockResolvedValueOnce(new Response(wavBlob(), { status: 200, headers: { 'content-type': 'audio/wav' } }))
    const fakeAudio = makeFakeAudio()
    vi.stubGlobal('Audio', function AudioStub() {
      return fakeAudio
    })

    const { readAloud, toggle } = useTts(() => view)
    await readAloud()
    await Promise.resolve()
    const callsBefore = vi.mocked(api).mock.calls.length
    await toggle() // playing → stop (no new request)
    await Promise.resolve()
    expect(vi.mocked(api).mock.calls.length).toBe(callsBefore)
  })

  it('is reactive: toggling stop updates isPlaying synchronously', async () => {
    const view = makeView()
    vi.mocked(api).mockResolvedValueOnce(new Response(wavBlob(), { status: 200, headers: { 'content-type': 'audio/wav' } }))
    const fakeAudio = makeFakeAudio()
    vi.stubGlobal('Audio', function AudioStub() {
      return fakeAudio
    })

    const { readAloud, stop, isPlaying } = useTts(() => view)
    await readAloud()
    await Promise.resolve()
    let seen = false
    effect(() => {
      if (!isPlaying.value) seen = true
    })
    stop()
    await Promise.resolve()
    expect(seen).toBe(true)
  })
})
