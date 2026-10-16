import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { browserBoundary } from './build/browser-boundary.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../..');
const { version } = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8'));

// Port 7435 beside the gateway's 7434; the existing `alp web` (7433) is left alone.
export default defineConfig({
  root: here,
  plugins: [tailwindcss(), browserBoundary({ repository })],
  resolve: { alias: { '@': path.join(here, 'src') } },
  esbuild: { jsx: 'automatic' },
  define: { __ALP_WEB_VERSION__: JSON.stringify(version) },
  server: { host: '127.0.0.1', port: 7435, strictPort: true },
  preview: { host: '127.0.0.1', port: 7435, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, target: 'es2022' },
});
