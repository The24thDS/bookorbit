import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { effect } from 'vue'

import { useTts, ssmlToPlainText, splitBlock } from '../useTts'
import type { FoliateTtsView } from '../useTts'

vi.mock('@/lib/api', () => ({
  api: vi.fn<() => Promise<Response>>(),
}))

import { api } from '@/lib/api'

type Mock<T extends (...a: never[]) => unknown> = ReturnType<typeof vi.fn<T>>

/** Typed bundle of the mocks backing a fake view, exposed for assertions. */
interface FakeView extends FoliateTtsView {
  initTTSMock: Mock<(g?: string, h?: unknown) => Promise<void>>
  startMock: Mock<() => string>
  nextMock: Mock<() => string>
  fromMock: Mock<(range: Range) => string>
  goToMock: Mock<(t: string | number) => Promise<unknown>>
  goToCalls: number[]
  loadListeners: EventListener[]
  dispatchLoad: (index: number) => void
}

/**
 * Fake foliate view. `sections` is an array of sections; each section is an
 * array of block SSML strings. `initTTS()` resets the within-section cursor
 * (foliate creates a fresh TTS each time the doc changes) and `goTo(index)`
 * switches the active section then emits a `load` event for it.
 */
function makeView(sections: string[][], opts: { lastRange?: Range | null; fromResult?: string } = {}): FakeView {
  let current = 0
  let cursor = 0
  const startMock = vi.fn<() => string>(() => sections[current]?.[cursor] ?? '')
  const nextMock = vi.fn<() => string>(() => {
    cursor++
    return sections[current]?.[cursor] ?? ''
  })
  const fromMock = vi.fn<(range: Range) => string>(() => opts.fromResult ?? sections[current]?.[0] ?? '')
  const initTTSMock = vi.fn<(g?: string, h?: unknown) => Promise<void>>().mockResolvedValue(undefined)
  const goToCalls: number[] = []
  const loadListeners: EventListener[] = []
  const goToMock = vi.fn<(t: string | number) => Promise<unknown>>(async (target: string | number) => {
    goToCalls.push(Number(target))
  })

  const view: FakeView = {
    initTTS: initTTSMock as unknown as FoliateTtsView['initTTS'],
    initTTSMock,
    tts: { start: startMock, next: nextMock, from: fromMock },
    startMock,
    nextMock,
    fromMock,
    lastLocation: { range: opts.lastRange === undefined ? ({} as Range) : (opts.lastRange ?? undefined) },
    goTo: goToMock as unknown as FoliateTtsView['goTo'],
    goToMock,
    goToCalls,
    addEventListener: vi.fn<(t: string, h: EventListenerOrEventListenerObject) => void>((_type, handler) => {
      loadListeners.push(handler as EventListener)
    }),
    removeEventListener: vi.fn<(t: string, h: EventListenerOrEventListenerObject) => void>((_type, handler) => {
      const i = loadListeners.indexOf(handler as EventListener)
      if (i >= 0) loadListeners.splice(i, 1)
    }),
    loadListeners,
    dispatchLoad(index: number) {
      current = index
      cursor = 0
      const evt = { detail: { doc: {}, index } } as unknown as Event
      loadListeners.slice().forEach((h) => h(evt))
    },
  }
  return view
}

function ssml(text: string): string {
  return `<speak xmlns="http://www.w3.org/2001/10/synthesis">${text}</speak>`
}

function wavBlob(): Blob {
  return new Blob(['RIFF…wav'], { type: 'audio/wav' })
}

/** A fresh Response (unread body) per call — real fetch returns fresh responses. */
function okSynth(): Mock<() => Promise<Response>> {
  return vi.fn<() => Promise<Response>>(async () => new Response(wavBlob(), { status: 200, headers: { 'content-type': 'audio/wav' } }))
}

/** Fake HTMLAudioElement: records listeners, dispatches 'play'/'pause' on a microtask. */
function makeFakeAudio() {
  const listeners = new Map<string, EventListener[]>()
  const audio = {
    addEventListener: vi.fn<(t: string, h: EventListener) => void>((type, handler) => {
      const arr = listeners.get(type) ?? []
      arr.push(handler)
      listeners.set(type, arr)
    }),
    removeEventListener: vi.fn<(t: string, h: EventListener) => void>((type, handler) => {
      const arr = listeners.get(type) ?? []
      const i = arr.indexOf(handler)
      if (i >= 0) arr.splice(i, 1)
    }),
    play: vi.fn<() => Promise<void>>(() => {
      queueMicrotask(() => listeners.get('play')?.forEach((h) => h(new Event('play'))))
      return Promise.resolve()
    }),
    pause: vi.fn<() => void>(() => {
      queueMicrotask(() => listeners.get('pause')?.forEach((h) => h(new Event('pause'))))
    }),
    src: '',
  }
  return {
    audio,
    /** Dispatch an event to the audio element's listeners (drives 'ended'). */
    dispatch(type: string) {
      listeners
        .get(type)
        ?.slice()
        .forEach((h) => h(new Event(type)))
    },
  }
}

async function flush(times = 8) {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

describe('ssmlToPlainText', () => {
  it('strips the speak wrapper and mark/break/emphasis tags to plain text', () => {
    expect(ssmlToPlainText('<speak xmlns="x">Hello <mark name="0"/>world<break/>there</speak>')).toBe('Hello worldthere')
  })
  it('returns empty string for empty input', () => {
    expect(ssmlToPlainText('')).toBe('')
  })
  it('falls back to a tag-stripped raw string if parsing yields no document element', () => {
    expect(ssmlToPlainText('not xml at all')).toBe('not xml at all')
  })
})

describe('splitBlock', () => {
  it('returns a single chunk when under the cap', () => {
    expect(splitBlock('short text', 4000)).toEqual(['short text'])
  })
  it('returns a single chunk at exactly the cap', () => {
    expect(splitBlock('a'.repeat(4000), 4000)).toEqual(['a'.repeat(4000)])
  })
  it('splits on sentence boundaries, keeping each chunk under the cap', () => {
    const sentence = 'This is a sentence. '
    const text = sentence.repeat(400)
    const chunks = splitBlock(text, 4000)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4000)
    expect(chunks.join('').replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''))
  })
  it('hard-splits a single sentence longer than the cap on word boundaries', () => {
    const word = 'word '.repeat(2000) // ~10k chars, no sentence punctuation
    const chunks = splitBlock(word, 4000)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4000)
    expect(chunks.join('').replace(/\s+/g, '')).toBe(word.replace(/\s+/g, ''))
  })
  it('hard-splits a single giant word by character when there are no breaks', () => {
    const text = 'x'.repeat(9000)
    const chunks = splitBlock(text, 4000)
    expect(chunks).toEqual([text.slice(0, 4000), text.slice(4000, 8000), text.slice(8000, 9000)])
  })
})

describe('useTts', () => {
  let revokeSpy: ReturnType<typeof vi.fn>
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api).mockReset()
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn<() => string>(() => 'blob:http://localhost/abc'),
      revokeObjectURL: (revokeSpy = vi.fn<() => void>()),
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function installAudio() {
    const fake = makeFakeAudio()
    vi.stubGlobal('Audio', function AudioStub() {
      return fake.audio
    })
    return fake
  }

  it('checkAvailability sets status flags and the reported cap from /api/v1/tts/status when enabled and reachable', async () => {
    vi.mocked(api).mockResolvedValueOnce(
      new Response(JSON.stringify({ enabled: true, reachable: true, maxChunkChars: 2500 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const { statusEnabled, statusReachable, statusMaxChunkChars, checkAvailability } = useTts(() => null)
    await checkAvailability()
    expect(statusEnabled.value).toBe(true)
    expect(statusReachable.value).toBe(true)
    expect(statusMaxChunkChars.value).toBe(2500)
  })

  it('readAloud splits overlong blocks at the server-reported cap, not the hardcoded floor', async () => {
    // Lower the server cap via /status to 100; the client must split at ≤100 even
    // though the option/option-less default is 4000.
    vi.mocked(api)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ enabled: true, reachable: true, maxChunkChars: 100 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockImplementation(okSynth())
    const view = makeView([[ssml('a'.repeat(250) + ' one.') + ' ' + ssml('two')]])
    installAudio()
    const { checkAvailability, readAloud } = useTts(() => view) // default cap 4000
    await checkAvailability()
    await readAloud()
    await flush()
    // Every synth request sent ≤ the reported 100-char cap.
    for (const call of vi.mocked(api).mock.calls) {
      if (String(call[0]) !== '/api/v1/tts/synthesize') continue
      const body = JSON.parse((call[1]?.body as string) ?? '{}')
      expect(body.input.length).toBeLessThanOrEqual(100)
    }
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

  it('readAloud starts narration from the current view position via tts.from(range)', async () => {
    const view = makeView([[ssml('Hello world'), ssml('Next block')]])
    vi.mocked(api).mockImplementation(okSynth())
    installAudio()
    const onActivity = vi.fn<() => void>()
    const { readAloud, isPlaying, error } = useTts(() => view, { onActivity })

    await readAloud()
    await flush()

    expect(view.fromMock).toHaveBeenCalledTimes(1)
    expect(view.startMock).not.toHaveBeenCalled()
    expect(view.initTTSMock).toHaveBeenCalledTimes(1)
    const [endpoint, init] = vi.mocked(api).mock.calls[0]
    expect(endpoint).toBe('/api/v1/tts/synthesize')
    expect(JSON.parse(init!.body as string)).toEqual({ input: 'Hello world' })
    expect(isPlaying.value).toBe(true)
    expect(error.value).toBeNull()
    expect(onActivity).toHaveBeenCalledTimes(1) // fed once at block 0 start
  })

  it('readAloud falls back to tts.start() when there is no current range', async () => {
    const view = makeView([[ssml('Hello world')]], { lastRange: null })
    vi.mocked(api).mockImplementation(okSynth())
    installAudio()
    const { readAloud } = useTts(() => view)
    await readAloud()
    await flush()
    expect(view.startMock).toHaveBeenCalledTimes(1)
    expect(view.fromMock).not.toHaveBeenCalled()
  })

  it('readAloud surfaces an error when there is no readable text', async () => {
    const view = makeView([['']])
    const { error, readAloud } = useTts(() => view)
    await readAloud()
    expect(error.value).toBe('No readable text on this page.')
  })

  it('readAloud surfaces a 503 as "unavailable"', async () => {
    const view = makeView([[ssml('Hello world')]])
    vi.mocked(api).mockResolvedValueOnce(new Response(null, { status: 503 }))
    const { error, readAloud } = useTts(() => view)
    await readAloud()
    await flush()
    expect(error.value).toBe('Read aloud is unavailable right now.')
  })

  it('narrates continuously block-to-block with a depth-3 prefetch buffer (no per-block synth gap)', async () => {
    // Default prefetchDepth = 3. Three-block section: block 0 plays while blocks
    // 1 and 2 are synthesised in the background; the section then ends.
    const view = makeView([[ssml('Block zero'), ssml('Block one'), ssml('Block two')]])
    vi.mocked(api).mockImplementation(okSynth())
    const fake = installAudio()
    const onActivity = vi.fn<() => void>()
    const { readAloud } = useTts(() => view, { onActivity })

    await readAloud()
    await flush()

    // Block 0 synthesised+played (call 1); blocks 1 and 2 prefetched (calls 2,3).
    // tts.next() advanced the cursor three times → block 1, block 2, then '' sentinel.
    const callsAfterStart = vi.mocked(api).mock.calls.length
    expect(callsAfterStart).toBe(3)
    expect(view.nextMock).toHaveBeenCalledTimes(3) // block1, block2, end-of-section sentinel

    // End of block 0 → block 1 plays from the already-prefetched blob; NO new
    // synthesis (the buffer covered it). onActivity fires for block 1.
    fake.dispatch('ended')
    await flush()
    expect(fake.audio.play.mock.calls.length).toBe(2)
    expect(onActivity).toHaveBeenCalledTimes(2)
    expect(vi.mocked(api).mock.calls.length).toBe(callsAfterStart) // still 3 — buffer absorbed it

    // End of block 1 → block 2 plays from the buffer; still no new synth.
    fake.dispatch('ended')
    await flush()
    expect(fake.audio.play.mock.calls.length).toBe(3)
    expect(onActivity).toHaveBeenCalledTimes(3)
    expect(vi.mocked(api).mock.calls.length).toBe(callsAfterStart)
  })

  it('prefetchDepth caps how many blocks are synthesised ahead', async () => {
    const view = makeView([[ssml('b0'), ssml('b1'), ssml('b2'), ssml('b3'), ssml('b4')]])
    vi.mocked(api).mockImplementation(okSynth())
    installAudio()

    // depth 2: block 0 (current) + blocks 1,2 prefetched → 3 synth calls, 2 cursor advances.
    const { readAloud } = useTts(() => view, { prefetchDepth: 2 })
    await readAloud()
    await flush()
    expect(vi.mocked(api).mock.calls.length).toBe(3)
    expect(view.nextMock).toHaveBeenCalledTimes(2)

    // Default depth 3 on a five-block section: block 0 + blocks 1,2,3 → 4 synth, 3 advances.
    const view2 = makeView([[ssml('b0'), ssml('b1'), ssml('b2'), ssml('b3'), ssml('b4')]])
    vi.mocked(api).mockReset().mockImplementation(okSynth())
    installAudio()
    const { readAloud: readAloud2 } = useTts(() => view2)
    await readAloud2()
    await flush()
    expect(vi.mocked(api).mock.calls.length).toBe(4)
    expect(view2.nextMock).toHaveBeenCalledTimes(3)
  })

  it('prefetch is aborted on stop (in-flight fetch does not linger or error)', async () => {
    const view = makeView([[ssml('Block zero'), ssml('Block one')]])
    // Block 0 resolves; block 1 prefetch hangs forever (aborted before it resolves).
    vi.mocked(api)
      .mockImplementationOnce(okSynth())
      .mockImplementationOnce(() => new Promise<Response>(() => {}))
    installAudio()
    const { readAloud, stop, error } = useTts(() => view)
    await readAloud()
    await flush()
    stop() // aborts the in-flight prefetch immediately
    await flush()
    expect(error.value).toBeNull()
  })

  it('crosses a section boundary automatically (renderer advance → load → re-init TTS → continue)', async () => {
    const view = makeView([[ssml('Section one block')], [ssml('Section two block')]])
    // goTo dispatches a load event for the requested section (mirrors foliate).
    view.goToMock.mockImplementation(async (target: string | number) => {
      view.goToCalls.push(Number(target))
      queueMicrotask(() => view.dispatchLoad(Number(target)))
    })

    vi.mocked(api).mockImplementation(okSynth())
    const fake = installAudio()
    const getSectionIndex = vi.fn<() => number>(() => 0)
    const getTotalSections = vi.fn<() => number>(() => 2)
    const { readAloud } = useTts(() => view, { getSectionIndex, getTotalSections })

    await readAloud()
    await flush()
    expect(view.nextMock).toHaveBeenCalledTimes(1) // prefetch found end of section
    const initTtsBefore = view.initTTSMock.mock.calls.length
    const startBefore = view.startMock.mock.calls.length

    fake.dispatch('ended') // end of block 0 → advance → end of section → advanceSection
    await flush(12)

    expect(view.goToCalls).toContain(1) // advanced to section index 1
    expect(view.initTTSMock.mock.calls.length).toBe(initTtsBefore + 1) // re-init for new doc
    expect(view.startMock.mock.calls.length).toBe(startBefore + 1) // start() of new section
    expect(fake.audio.play.mock.calls.length).toBe(2) // section two block played
  })

  it('stops playback and fires onEndOfBook at end of book', async () => {
    const view = makeView([[ssml('Only block')]])
    vi.mocked(api).mockImplementation(okSynth())
    const fake = installAudio()
    const onEndOfBook = vi.fn<() => void>()
    const getSectionIndex = vi.fn<() => number>(() => 0)
    const getTotalSections = vi.fn<() => number>(() => 1) // one section → can't advance → end of book
    const { readAloud, isPlaying } = useTts(() => view, { onEndOfBook, getSectionIndex, getTotalSections })

    await readAloud()
    await flush()
    fake.dispatch('ended') // only block ends → prefetch empty → end of book
    await flush(12)
    expect(onEndOfBook).toHaveBeenCalledTimes(1)
    expect(isPlaying.value).toBe(false)
  })

  it('does not feed the reading session after stop', async () => {
    const view = makeView([[ssml('Block zero'), ssml('Block one')]])
    vi.mocked(api).mockImplementation(okSynth())
    const fake = installAudio()
    const onActivity = vi.fn<() => void>()
    const { readAloud, stop } = useTts(() => view, { onActivity })

    await readAloud()
    await flush()
    const fedBefore = onActivity.mock.calls.length
    stop()
    fake.dispatch('ended') // ignored after stop
    await flush()
    expect(onActivity.mock.calls.length).toBe(fedBefore)
  })

  it('stop revokes the object URL and pauses playback', async () => {
    const view = makeView([[ssml('Hello world')]])
    vi.mocked(api).mockImplementation(okSynth())
    const fake = installAudio()
    const { readAloud, stop, isPlaying } = useTts(() => view)
    await readAloud()
    await flush()
    stop()
    await flush()
    expect(fake.audio.pause).toHaveBeenCalled()
    expect(revokeSpy).toHaveBeenCalledWith('blob:http://localhost/abc')
    expect(isPlaying.value).toBe(false)
  })

  it('toggle stops playback if currently loading or playing', async () => {
    const view = makeView([[ssml('Hello world')]])
    vi.mocked(api).mockImplementation(okSynth())
    installAudio()
    const { readAloud, toggle } = useTts(() => view)
    await readAloud()
    await flush()
    const callsBefore = vi.mocked(api).mock.calls.length
    await toggle() // playing → stop (no new request)
    await flush()
    expect(vi.mocked(api).mock.calls.length).toBe(callsBefore)
  })

  it('is reactive: toggling stop updates isPlaying synchronously', async () => {
    const view = makeView([[ssml('Hello world')]])
    vi.mocked(api).mockImplementation(okSynth())
    installAudio()
    const { readAloud, stop, isPlaying } = useTts(() => view)
    await readAloud()
    await flush()
    let seen = false
    effect(() => {
      if (!isPlaying.value) seen = true
    })
    stop()
    await flush()
    expect(seen).toBe(true)
  })
})
