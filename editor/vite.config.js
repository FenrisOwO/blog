import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// The editor is a separate app: it is built into editor/dist and served from
// `/editor/` by server/index.js. It is never written into site/public, so it cannot
// leak into the deployed Hugo output.
export default defineConfig({
  root: 'web',
  base: '/editor/',
  plugins: [vue()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
