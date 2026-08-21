import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

import { faqSchema } from './scripts/vite-seo';

const websrSrc = fileURLToPath(new URL('./node_modules/@websr/websr/src/', import.meta.url));

export default defineConfig({
  // Deployed at seeb4coding.in/ai-upscaler/. Every asset URL is resolved
  // against this, so a different subpath (GitHub Pages serves the repo name)
  // has to override it — the Pages workflow sets BASE_PATH.
  base: process.env['BASE_PATH'] ?? '/ai-upscaler/',
  plugins: [faqSchema()],
  build: {
    target: 'es2022',
  },
  resolve: {
    // Regex finds, so the bare specifier matches exactly. A plain string alias
    // matches by prefix, which would also swallow `@websr/websr/src/...` deep
    // imports and rewrite them into a nonexistent path.
    alias: [
      {
        // The published dist bundle is a webpack *development* build: it wraps
        // every module in eval(), which bloats the output and breaks under a
        // strict CSP. The package ships plain TypeScript sources, so compile
        // those instead.
        find: /^@websr\/websr$/,
        replacement: `${websrSrc}main.ts`,
      },
      {
        // Deep imports used by our width-generic networks in src/websr-ext.
        find: /^@websr\/websr\/src\//,
        replacement: websrSrc,
      },
    ],
  },
});
