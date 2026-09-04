/* ------------------------------------------------------------------ *
 * GitHub 저장소를 한 번에 지정한다.
 *
 *   npm run setup:repo -- myname/md-viewer
 *
 * package.json 의 repository 와 tauri.conf.json 의 업데이트 확인 주소를
 * 함께 고쳐서, 두 곳 중 하나만 바꿔 두는 실수를 막는다.
 * ------------------------------------------------------------------ */

import { readFileSync, writeFileSync } from 'node:fs';

const arg = process.argv[2];

if (!arg || !/^[\w.-]+\/[\w.-]+$/.test(arg)) {
  console.error('사용법: npm run setup:repo -- <소유자>/<저장소>');
  console.error('예시  : npm run setup:repo -- hong-gildong/md-viewer');
  process.exit(1);
}

const [owner, repo] = arg.split('/');

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
pkg.repository = { type: 'git', url: `https://github.com/${owner}/${repo}.git` };
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');

const confPath = 'src-tauri/tauri.conf.json';
const conf = JSON.parse(readFileSync(confPath, 'utf8'));
conf.plugins.updater.endpoints = [
  `https://github.com/${owner}/${repo}/releases/latest/download/latest.json`,
];
writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');

console.log(`저장소를 ${owner}/${repo} 로 설정했습니다.`);
console.log('이제 다음 순서로 올리면 됩니다:');
console.log(`  git remote add origin https://github.com/${owner}/${repo}.git`);
console.log('  git add -A && git commit -m "저장소 설정"');
console.log('  git push -u origin main');
