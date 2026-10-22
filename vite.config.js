import { defineConfig } from 'vite';

// Relative base so the built `dist/` works from any static host or sub-path
// (GitHub Pages, a NAS share, or just opening it through a local server).
export default defineConfig({
  base: './',
  worker: { format: 'es' },
});
