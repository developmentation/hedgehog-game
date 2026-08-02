import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    rollupOptions: { output: { manualChunks: undefined } },
  },
  server: { host: '127.0.0.1' },
});
