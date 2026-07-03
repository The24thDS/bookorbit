<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  ArrowLeft,
  BookOpen,
  BookText,
  Bookmark,
  BookmarkCheck,
  CircleHelp,
  Clock3,
  FileText,
  LoaderCircle,
  Maximize,
  Minimize,
  Search,
  Settings,
  Square,
  Volume2,
} from '@lucide/vue'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const props = defineProps<{
  chapterTitle: string
  isBookmarked: boolean
  settingsOpen: boolean
  footerMode: 0 | 1 | 2
  peekMode?: boolean
  ttsAvailable?: boolean
  ttsPlaying?: boolean
  ttsLoading?: boolean
}>()

const emit = defineEmits<{
  back: []
  toggleSidebar: []
  toggleSearch: []
  toggleBookmark: []
  'update:settingsOpen': [open: boolean]
  toggleFullscreen: []
  toggleHelp: []
  cycleFooterMode: []
  startReading: []
}>()

// Hidden entirely when TTS is off/down, the user lacks TtsAccess, or the reader
// is in peek mode (no full reading session = no read-aloud). See issue #2.
const showTtsButton = computed(() => props.ttsAvailable && !props.peekMode)

// The TTS control popover is toolbar-local state (radix closes it on Escape and
// outside click); the parent doesn't need to drive its open state.
const ttsOpen = ref(false)

const isFullscreen = ref(false)

function onFullscreenChange() {
  isFullscreen.value = !!document.fullscreenElement
}

function onSettingsOpenChange(open: boolean) {
  emit('update:settingsOpen', open)
}

function getFooterModeIcon(mode: 0 | 1 | 2) {
  if (mode === 0) return FileText
  if (mode === 1) return Clock3
  return BookText
}

function getFooterModeTooltip(mode: 0 | 1 | 2): string {
  if (mode === 0) return 'Footer info: page + progress'
  if (mode === 1) return 'Footer info: reading session + time left'
  return 'Footer info: chapter + chapter time left'
}

onMounted(() => document.addEventListener('fullscreenchange', onFullscreenChange))
onUnmounted(() => document.removeEventListener('fullscreenchange', onFullscreenChange))

function getTtsIcon() {
  if (props.ttsLoading) return LoaderCircle
  return props.ttsPlaying ? Square : Volume2
}

function getTtsLabel() {
  if (props.ttsLoading) return 'Reading block aloud…'
  return props.ttsPlaying ? 'Stop read aloud' : 'Read aloud'
}
</script>

<template>
  <header
    class="fixed top-0 left-0 right-0 h-10 sm:h-11 z-50 flex items-center px-2 sm:px-3 gap-1 bg-background/90 backdrop-blur-md border-b border-border"
  >
    <!-- Left button group -->
    <div class="flex items-center gap-1 shrink-0">
      <Tooltip>
        <TooltipTrigger as-child>
          <button class="viewer-btn" aria-label="Go back" @click="emit('back')">
            <ArrowLeft :size="18" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Go back</TooltipContent>
      </Tooltip>

      <div class="viewer-sep" />

      <Tooltip>
        <TooltipTrigger as-child>
          <button class="viewer-btn" aria-label="Table of contents" @click="emit('toggleSidebar')">
            <BookOpen :size="18" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Table of contents</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger as-child>
          <button class="viewer-btn" :class="isBookmarked ? '!text-primary' : ''" aria-label="Toggle bookmark" @click="emit('toggleBookmark')">
            <BookmarkCheck v-if="isBookmarked" :size="18" />
            <Bookmark v-else :size="18" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Toggle bookmark</TooltipContent>
      </Tooltip>
    </div>

    <!-- Title: desktop/tablet only to avoid overlap on narrow mobile headers -->
    <div class="hidden sm:absolute sm:inset-x-0 sm:top-0 sm:h-12 sm:flex sm:items-center sm:justify-center sm:pointer-events-none">
      <p class="text-sm font-serif font-medium truncate text-center text-muted-foreground max-w-[40vw]">{{ chapterTitle }}</p>
    </div>

    <!-- Right button group -->
    <div class="flex items-center gap-1 shrink-0 ml-auto">
      <div v-if="props.peekMode" class="flex h-7 items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-1.5 text-primary">
        <span class="hidden text-[11px] font-medium sm:inline">Peeking</span>
        <button
          class="h-5 rounded-sm bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90 sm:h-6 sm:px-2 sm:text-[11px]"
          @click="emit('startReading')"
        >
          Start reading
        </button>
      </div>

      <Popover v-if="showTtsButton" v-model:open="ttsOpen">
        <PopoverTrigger as-child>
          <button
            class="viewer-btn"
            :class="props.ttsPlaying ? '!text-primary' : ''"
            :title="getTtsLabel()"
            :aria-label="getTtsLabel()"
            :aria-pressed="props.ttsPlaying"
          >
            <component :is="getTtsIcon()" :size="18" :class="props.ttsLoading ? 'animate-spin' : ''" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" :side-offset="10" class="w-72 max-w-[calc(100vw-1rem)] rounded-lg border-border bg-card p-0 shadow-2xl">
          <slot name="ttsControls" />
        </PopoverContent>
      </Popover>

      <Tooltip>
        <TooltipTrigger as-child>
          <button class="viewer-btn" aria-label="Search" @click="emit('toggleSearch')">
            <Search :size="18" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Search</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger as-child>
          <button class="viewer-btn hidden sm:flex" aria-label="Cycle footer info mode" @click="emit('cycleFooterMode')">
            <component :is="getFooterModeIcon(props.footerMode)" :size="16" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{{ getFooterModeTooltip(props.footerMode) }}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger as-child>
          <button class="viewer-btn hidden sm:flex" aria-label="Keyboard shortcuts" @click="emit('toggleHelp')">
            <CircleHelp :size="18" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Keyboard shortcuts (?)</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger as-child>
          <button
            class="viewer-btn hidden sm:flex"
            :aria-label="isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'"
            @click="emit('toggleFullscreen')"
          >
            <Minimize v-if="isFullscreen" :size="18" />
            <Maximize v-else :size="18" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{{ isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen' }}</TooltipContent>
      </Tooltip>

      <DropdownMenu :open="props.settingsOpen" @update:open="onSettingsOpenChange">
        <DropdownMenuTrigger as-child>
          <button class="viewer-btn" :class="props.settingsOpen ? '!bg-muted !text-foreground' : ''" title="Settings" aria-label="Reader settings">
            <Settings :size="18" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          side="bottom"
          :side-offset="10"
          class="w-[22rem] max-w-[calc(100vw-1rem)] max-h-[min(80vh,38rem)] rounded-lg border-border bg-card p-0 shadow-2xl overflow-hidden"
        >
          <slot name="settingsPanel" />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </header>
</template>
