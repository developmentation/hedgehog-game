import { defineConfig } from 'vite';

export default defineConfig({
  define: {
    // Stamped at build time so a stale cached bundle is identifiable.
    __BUILD_STAMP__: JSON.stringify(new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'),
  },
  base: './',
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    rollupOptions: { output: { manualChunks: undefined } },
  },
  server: { host: '127.0.0.1' },
});
