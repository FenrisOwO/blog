<script setup>
// The modal shell every dialog shares: the backdrop, the header, the scrolling body and the
// footer. All of its look comes from the design system (web/styles/base.css), so a new dialog
// cannot invent its own spacing or colours.

import { onBeforeUnmount, onMounted } from 'vue';

defineProps({
  title: { type: String, required: true },
  busy: { type: Boolean, default: false },
  wide: { type: Boolean, default: false },
  narrow: { type: Boolean, default: false },
});

const emit = defineEmits(['close']);

function onKeydown(event) {
  if (event.key === 'Escape') emit('close');
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div class="dialog-backdrop" @click.self="emit('close')">
    <div class="dialog" :class="{ wide, narrow }" role="dialog" aria-modal="true" :aria-label="title">
      <header class="dialog-head">
        <h3>{{ title }}</h3>
        <span class="spacer"></span>
        <button type="button" class="icon-btn" :disabled="busy" aria-label="关闭" title="关闭 (Esc)" @click="emit('close')">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke-linecap="round" />
          </svg>
        </button>
      </header>
      <div class="dialog-body">
        <slot />
      </div>
      <footer v-if="$slots.footer" class="dialog-foot">
        <slot name="footer" />
      </footer>
    </div>
  </div>
</template>
