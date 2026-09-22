import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 版本号单一来源：package.json。构建期注入渲染层，避免首帧拿不到 app.getVersion()
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as {
  version: string;
};

export default defineConfig({
  root: '.',
  base: './',
  plugins: [react()],
  define: { __TALLY_VERSION__: JSON.stringify(pkg.version) },
  build: { outDir: 'dist', emptyOutDir: true, target: 'chrome120' },
  server: { port: 5199, strictPort: true },
});
