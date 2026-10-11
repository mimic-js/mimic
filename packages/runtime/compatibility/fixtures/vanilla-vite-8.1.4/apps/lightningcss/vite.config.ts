import { defineConfig } from 'vite';

export default defineConfig({
  css: { transformer: 'lightningcss' },
  optimizeDeps: { entries: ['index.html'] }
});