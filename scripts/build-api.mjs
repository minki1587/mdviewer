/* ------------------------------------------------------------------ *
 * window.api 번들 — Tauri 커맨드 래퍼 + 마크다운 변환기를 한 파일로 묶는다.
 * 결과물: renderer/vendor/api.js  (renderer.js 보다 먼저 실행되어야 한다)
 * ------------------------------------------------------------------ */

import * as esbuild from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync(new URL('../renderer/vendor/', import.meta.url), { recursive: true });

await esbuild.build({
  entryPoints: ['scripts/api-entry.js'],
  outfile: 'renderer/vendor/api.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  minify: true,
  legalComments: 'none',
});

console.log('renderer/vendor/api.js 생성 완료');
