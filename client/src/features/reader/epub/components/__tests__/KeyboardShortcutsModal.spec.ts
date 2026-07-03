import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import KeyboardShortcutsModal from '../KeyboardShortcutsModal.vue'

const globalStubs = {
  stubs: {
    X: { template: '<span>X</span>' },
  },
}

describe('KeyboardShortcutsModal', () => {
  it('renders all shortcut entries', () => {
    const wrapper = mount(KeyboardShortcutsModal, { global: globalStubs })

    const kbds = wrapper.findAll('kbd')
    expect(kbds.length).toBeGreaterThanOrEqual(8)

    const text = wrapper.text()
    expect(text).toContain('Toggle table of contents')
    expect(text).toContain('Toggle search')
    expect(text).toContain('Toggle bookmark')
    expect(text).toContain('Toggle fullscreen')
    expect(text).toContain('Cycle footer info mode')
    expect(text).toContain('Show/hide this help')
    expect(text).toContain('Go to start of book')
    expect(text).toContain('Go to end of book')
    expect(text).toContain('Close panel')
    expect(text).toContain('Previous/next page')
    expect(text).toContain('Toggle read aloud (play/pause)')
    expect(text).toContain('Alt+P')
  })

  it('renders the title', () => {
    const wrapper = mount(KeyboardShortcutsModal, { global: globalStubs })
    expect(wrapper.text()).toContain('Keyboard Shortcuts')
  })

  it('emits close when close button is clicked', async () => {
    const wrapper = mount(KeyboardShortcutsModal, { global: globalStubs })

    const closeButton = wrapper.find('button')
    await closeButton.trigger('click')

    expect(wrapper.emitted('close')?.length).toBe(1)
  })

  it('emits close when Escape is pressed', async () => {
    const wrapper = mount(KeyboardShortcutsModal, { global: globalStubs })

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('close')?.length).toBe(1)
  })

  it('emits close when backdrop is clicked', async () => {
    const wrapper = mount(KeyboardShortcutsModal, { global: globalStubs })

    const backdrop = wrapper.find('[data-backdrop]')
    await backdrop.trigger('click')

    expect(wrapper.emitted('close')?.length).toBe(1)
  })

  it('does not emit close when modal content is clicked', async () => {
    const wrapper = mount(KeyboardShortcutsModal, { global: globalStubs })

    const content = wrapper.find('[class*="rounded-lg"]')
    await content.trigger('click')

    // The click handler checks data-backdrop, so clicking inside should not emit close
    expect(wrapper.emitted('close')).toBeUndefined()
  })
})
