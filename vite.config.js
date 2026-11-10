import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const repo = fileURLToPath(new URL('.', import.meta.url));
const extension = resolve(repo, 'extension');

export default defineConfig({
  root: extension,
  base: './',
  publicDir: false,
  build: {
    outDir: resolve(repo, 'build/extension'),
    emptyOutDir: true,
    target: 'firefox140',
    modulePreload: false,
    sourcemap: false,
    minify: 'oxc',
    cssMinify: 'lightningcss',
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        newtab: resolve(extension, 'newtab.html'),
        options: resolve(extension, 'options.html'),
        background: resolve(extension, 'background.js'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: asset => {
          const name = asset.names[0] || '';
          if (name.endsWith('.css')) return 'newtab.css';
          if (/\.(ttf|woff2?)$/i.test(name)) return 'fonts/[name][extname]';
          return 'icons/[name][extname]';
        },
      },
    },
  },
});
