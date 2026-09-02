import * as esbuild from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync(new URL('../renderer/vendor/', import.meta.url), { recursive: true });

await esbuild.build({
  entryPoints: ['scripts/editor-entry.js'],
  outfile: 'renderer/vendor/editor.js',
  bundle: true,
  format: 'iife',
  globalName: 'MDEditor',
  target: 'chrome120',
  minify: true,
  legalComments: 'none',
});

console.log('renderer/vendor/editor.js 생성 완료');
