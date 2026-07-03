<script setup lang="ts">
import { computed } from 'vue'
import { LoaderCircle, Pause, Play, SkipBack, SkipForward, Square, Volume2 } from '@lucide/vue'

/**
 * Read-aloud controls rendered inside the ReaderHeader "Read aloud" popover.
 * Presentational only: all state lives in the `useTts` composable via props +
 * emits, mirroring the reader's panel language (`ReaderSearchPanel`,
 * `ReaderSettingsPanel`). A Voice is a synthetic timbre (see CONTEXT.md) — the
 * UI never calls it a "narrator".
 */

const props = defineProps<{
  isPlaying: boolean
  isLoading: boolean
  builtinVoices: string[]
  customVoices: string[]
  /** Selected voice id, or null for the sidecar default. */
  voice: string | null
  /** Client-side playback rate (0.75×–2×). */
  playbackRate: number
}>()

const emit = defineEmits<{
  /** Smart play/pause — the composable decides pause vs resume vs start. */
  toggle: []
  stop: []
  skipNext: []
  skipPrev: []
  'update:voice': [voice: string | null]
  'update:playbackRate': [rate: number]
}>()

const MIN_RATE = 0.75
const MAX_RATE = 2
const RATE_STEP = 0.25

const rateModel = computed({
  get: () => props.playbackRate,
  set: (v: number) => {
    const clamped = Math.min(MAX_RATE, Math.max(MIN_RATE, Number(v) || 1))
    emit('update:playbackRate', clamped)
  },
})

const voiceModel = computed<string>({
  // '' (no voice selected) maps to null = sidecar default.
  get: () => props.voice ?? '',
  set: (v: string) => emit('update:voice', v === '' ? null : v),
})

function toggleIcon() {
  if (props.isLoading) return LoaderCircle
  return props.isPlaying ? Pause : Play
}
</script>

<template>
  <div class="p-3">
    <!-- Transport -->
    <div class="flex items-center justify-center gap-2">
      <button
        class="flex items-center justify-center w-9 h-9 rounded-md text-foreground/70 hover:text-foreground hover:bg-muted transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        aria-label="Previous block"
        :disabled="isLoading"
        @click="emit('skipPrev')"
      >
        <SkipBack :size="18" />
      </button>

      <button
        class="flex items-center justify-center w-11 h-11 rounded-md bg-muted text-foreground transition-colors hover:bg-muted"
        :class="props.isPlaying ? '!bg-primary !text-primary-foreground' : ''"
        :aria-label="props.isPlaying ? 'Pause' : 'Play'"
        @click="emit('toggle')"
      >
        <component :is="toggleIcon()" :size="20" :class="props.isLoading ? 'animate-spin' : ''" />
      </button>

      <button
        class="flex items-center justify-center w-9 h-9 rounded-md text-foreground/70 hover:text-foreground hover:bg-muted transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        aria-label="Next block"
        :disabled="isLoading"
        @click="emit('skipNext')"
      >
        <SkipForward :size="18" />
      </button>

      <button
        class="flex items-center justify-center w-9 h-9 rounded-md text-foreground/70 hover:text-foreground hover:bg-muted transition-colors"
        aria-label="Stop"
        @click="emit('stop')"
      >
        <Square :size="18" />
      </button>
    </div>

    <!-- Voice picker -->
    <div class="mt-3">
      <label for="tts-voice" class="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Volume2 :size="12" />
        Voice
      </label>
      <select
        id="tts-voice"
        v-model="voiceModel"
        aria-label="Voice"
        class="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:border-primary"
      >
        <option value="">Default</option>
        <optgroup v-if="props.builtinVoices.length" label="Built-in">
          <option v-for="id in props.builtinVoices" :key="id" :value="id">{{ id }}</option>
        </optgroup>
        <optgroup v-if="props.customVoices.length" label="Custom">
          <option v-for="id in props.customVoices" :key="id" :value="id">{{ id }}</option>
        </optgroup>
      </select>
    </div>

    <!-- Speed -->
    <div class="mt-3">
      <label for="tts-speed" class="mb-1 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <span>Speed</span>
        <span class="font-mono tabular-nums">{{ props.playbackRate.toFixed(2).replace(/\.?0+$/, '') }}×</span>
      </label>
      <input
        id="tts-speed"
        v-model.number="rateModel"
        type="range"
        :min="MIN_RATE"
        :max="MAX_RATE"
        :step="RATE_STEP"
        aria-label="Speed"
        class="w-full accent-primary"
      />
      <div class="mt-0.5 flex justify-between text-[10px] text-muted-foreground/70">
        <span>0.75×</span>
        <span>2×</span>
      </div>
    </div>
  </div>
</template>
