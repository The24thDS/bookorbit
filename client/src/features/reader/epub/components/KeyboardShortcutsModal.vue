<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { Keyboard, X } from '@lucide/vue'

const emit = defineEmits<{
  close: []
}>()

const shortcutGroups = [
  {
    title: 'Panels',
    shortcuts: [
      { key: 't', description: 'Toggle table of contents' },
      { key: 's', description: 'Toggle search' },
      { key: '?', description: 'Show/hide this help' },
      { key: 'Esc', description: 'Close panel' },
    ],
  },
  {
    title: 'Reading',
    shortcuts: [
      { key: '← →', description: 'Previous/next page' },
      { key: 'Alt+P', description: 'Toggle read aloud (play/pause)' },
      { key: 'Home', description: 'Go to start of book' },
      { key: 'End', description: 'Go to end of book' },
    ],
  },
  {
    title: 'Actions',
    shortcuts: [
      { key: 'b', description: 'Toggle bookmark' },
      { key: 'f', description: 'Toggle fullscreen' },
      { key: 'm', description: 'Cycle footer info mode' },
    ],
  },
]

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    emit('close')
  }
}

function handleBackdropClick(e: MouseEvent) {
  if ((e.target as HTMLElement).dataset.backdrop !== undefined) {
    emit('close')
  }
}

onMounted(() => document.addEventListener('keydown', onKeyDown, true))
onUnmounted(() => document.removeEventListener('keydown', onKeyDown, true))
</script>

<template>
  <div data-backdrop class="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 px-4 backdrop-blur-sm" @click="handleBackdropClick">
    <div class="w-full max-w-md rounded-xl border border-border/80 bg-card shadow-2xl">
      <div class="flex items-center justify-between border-b border-border/80 bg-gradient-to-br from-muted/75 via-card to-muted/40 px-4 py-3">
        <div class="inline-flex items-center gap-2">
          <Keyboard :size="14" class="text-primary" />
          <h2 class="text-sm font-semibold text-foreground">Keyboard Shortcuts</h2>
        </div>

        <button class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" @click="emit('close')">
          <X :size="16" />
        </button>
      </div>

      <div class="grid grid-cols-1 gap-2.5 px-4 py-3 sm:grid-cols-2">
        <section v-for="group in shortcutGroups" :key="group.title" class="rounded-lg border border-border/70 bg-background/40 p-2.5">
          <div class="mb-1.5">
            <h3 class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{{ group.title }}</h3>
          </div>

          <div class="space-y-1">
            <div v-for="shortcut in group.shortcuts" :key="shortcut.key" class="flex items-center gap-2 rounded-md px-1 py-0.5 text-sm">
              <kbd
                class="inline-flex h-7 min-w-12 items-center justify-center rounded-md border border-border bg-card px-2.5 text-xs font-bold tracking-wide text-foreground shadow-[inset_0_-1px_0_0_hsl(var(--border))]"
              >
                {{ shortcut.key }}
              </kbd>
              <span class="text-[12px] leading-5 text-muted-foreground">{{ shortcut.description }}</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>
