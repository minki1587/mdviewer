/* renderer/api-entry.js 를 renderer/vendor/api.js 로 묶는다.
   Electron 판에서 preload.js 가 하던 일을 대신하는 파일이라,
   renderer.js 보다 먼저 로드되어 window.api 를 만들어 둔다. */

import * as esbuild from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync(new URL('../renderer/vendor/', import.meta.url), { recursive: true });

await esbuild.build({
  entryPoints: ['renderer/api-entry.js'],
  outfile: 'renderer/vendor/api.js',
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  minify: true,
  legalComments: 'none',
});

console.log('renderer/vendor/api.js 생성 완료');
