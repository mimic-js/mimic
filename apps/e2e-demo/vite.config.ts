import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { mimic } from '@mimic-js/mimic/vite';

export default defineConfig({
  plugins: [react(), mimic()]
});
