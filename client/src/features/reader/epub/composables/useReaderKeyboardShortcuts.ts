import { onMounted, onUnmounted, ref } from 'vue'

export interface ShortcutHandlers {
  toggleSidebar: () => void
  toggleSearch: () => void
  toggleBookmark: () => void
  toggleFullscreen: () => void
  cycleFooterMode: () => void
  /** Alt+P — toggles read-aloud play/pause. */
  toggleTts: () => void
  closePanel: () => void
  goToStart: () => void
  goToEnd: () => void
}

const INTERACTIVE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

export function useReaderKeyboardShortcuts(handlers: ShortcutHandlers) {
  const showHelpModal = ref(false)

  function onKeyDown(e: KeyboardEvent) {
    const target = (e.composedPath?.()[0] || e.target) as HTMLElement | null
    if (target && (INTERACTIVE_TAGS.has(target.tagName) || target.isContentEditable)) return

    // Alt+P — toggle read-aloud (modifier shortcut, checked before the bare-key switch).
    if (e.altKey && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault()
      handlers.toggleTts()
      return
    }

    switch (e.key) {
      case 't':
        e.preventDefault()
        handlers.toggleSidebar()
        break
      case 's':
        e.preventDefault()
        handlers.toggleSearch()
        break
      case 'b':
        e.preventDefault()
        handlers.toggleBookmark()
        break
      case 'f':
        e.preventDefault()
        handlers.toggleFullscreen()
        break
      case 'm':
        e.preventDefault()
        handlers.cycleFooterMode()
        break
      case 'Escape':
        e.preventDefault()
        if (showHelpModal.value) {
          showHelpModal.value = false
        } else {
          handlers.closePanel()
        }
        break
      case '?':
        e.preventDefault()
        showHelpModal.value = !showHelpModal.value
        break
      case 'Home':
        e.preventDefault()
        handlers.goToStart()
        break
      case 'End':
        e.preventDefault()
        handlers.goToEnd()
        break
    }
  }

  onMounted(() => {
    document.addEventListener('keydown', onKeyDown)
  })

  onUnmounted(() => {
    document.removeEventListener('keydown', onKeyDown)
  })

  return { showHelpModal }
}
