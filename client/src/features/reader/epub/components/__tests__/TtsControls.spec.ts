import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import TtsControls from '../TtsControls.vue'

const iconStubs = {
  Play: { template: '<span>play</span>' },
  Pause: { template: '<span>pause</span>' },
  Square: { template: '<span>square</span>' },
  SkipBack: { template: '<span>back</span>' },
  SkipForward: { template: '<span>fwd</span>' },
  Volume2: { template: '<span>vol</span>' },
  LoaderCircle: { template: '<span>spinner</span>' },
}

const global = { stubs: iconStubs }

function mountControls(overrides: Record<string, unknown> = {}) {
  return mount(TtsControls, {
    props: {
      isPlaying: false,
      isLoading: false,
      builtinVoices: ['cosette', 'jean'],
      customVoices: ['my-clone'],
      voice: null,
      playbackRate: 1,
      ...overrides,
    },
    global,
  })
}

describe('TtsControls', () => {
  it('renders transport buttons', () => {
    const w = mountControls({ isPlaying: true })
    expect(w.find('button[aria-label="Previous block"]').exists()).toBe(true)
    expect(w.find('button[aria-label="Next block"]').exists()).toBe(true)
    expect(w.find('button[aria-label="Stop"]').exists()).toBe(true)
    expect(w.find('button[aria-label="Pause"]').exists()).toBe(true) // playing → Pause
  })

  it('shows the Play label when idle and Pause when playing', async () => {
    const w = mountControls({ isPlaying: false })
    expect(w.find('button[aria-label="Play"]').exists()).toBe(true)
    await w.setProps({ isPlaying: true })
    expect(w.find('button[aria-label="Pause"]').exists()).toBe(true)
    expect(w.find('button[aria-label="Play"]').exists()).toBe(false)
  })

  it('emits toggle on the play/pause button', async () => {
    const w = mountControls()
    await w.get('button[aria-label="Play"]').trigger('click')
    expect(w.emitted('toggle')?.length).toBe(1)
  })

  it('emits stop / skipNext / skipPrev from the transport buttons', async () => {
    const w = mountControls()
    await w.get('button[aria-label="Stop"]').trigger('click')
    await w.get('button[aria-label="Next block"]').trigger('click')
    await w.get('button[aria-label="Previous block"]').trigger('click')
    expect(w.emitted('stop')?.length).toBe(1)
    expect(w.emitted('skipNext')?.length).toBe(1)
    expect(w.emitted('skipPrev')?.length).toBe(1)
  })

  it('populates the Voice picker from built-in and custom voices, using the term Voice', () => {
    const w = mountControls()
    expect(w.text()).toContain('Voice')
    const options = w.findAll('select[aria-label="Voice"] option')
    const values = options.map((o) => o.attributes('value'))
    expect(values).toContain('') // Default
    expect(values).toContain('cosette')
    expect(values).toContain('jean')
    expect(values).toContain('my-clone')
    expect(w.find('optgroup[label="Built-in"]').exists()).toBe(true)
    expect(w.find('optgroup[label="Custom"]').exists()).toBe(true)
  })

  it('emits update:voice with the chosen id, or null for Default', async () => {
    const w = mountControls()
    await w.get('select[aria-label="Voice"]').setValue('cosette')
    expect(w.emitted('update:voice')?.[0]).toEqual(['cosette'])
    await w.get('select[aria-label="Voice"]').setValue('')
    expect(w.emitted('update:voice')?.[1]).toEqual([null])
  })

  it('emits update:playbackRate as a number from the speed slider', async () => {
    const w = mountControls()
    await w.get('input[aria-label="Speed"]').setValue('1.5')
    expect(w.emitted('update:playbackRate')?.[0]).toEqual([1.5])
  })

  it('clamps the speed within 0.75×–2×', async () => {
    const w = mountControls()
    await w.get('input[aria-label="Speed"]').setValue('0.25')
    expect(w.emitted('update:playbackRate')?.[0]).toEqual([0.75])
    await w.get('input[aria-label="Speed"]').setValue('3')
    expect(w.emitted('update:playbackRate')?.[1]).toEqual([2])
  })

  it('renders speed range bounds 0.75× and 2×', () => {
    const w = mountControls()
    expect(w.text()).toContain('0.75×')
    expect(w.text()).toContain('2×')
  })
})
