import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:4317' } },
  build: { chunkSizeWarningLimit: 1500, rollupOptions: { output: { manualChunks: (id) => (id.includes('node_modules/echarts') || id.includes('node_modules/zrender') ? 'echarts' : undefined) } } },
});
