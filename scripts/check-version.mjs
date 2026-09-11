import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFile(path.join(root, relativePath), 'utf8');

const packageJson = JSON.parse(await read('package.json'));
const packageLock = JSON.parse(await read('package-lock.json'));
const tauriConfig = JSON.parse(await read('src-tauri/tauri.conf.json'));
const cargoToml = await read('src-tauri/Cargo.toml');
const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m)?.[1];

const versions = new Map([
  ['package.json', packageJson.version],
  ['package-lock.json', packageLock.version],
  ['package-lock.json 루트 패키지', packageLock.packages?.['']?.version],
  ['src-tauri/Cargo.toml', cargoVersion],
  ['src-tauri/tauri.conf.json', tauriConfig.version],
]);

const expected = packageJson.version;
const mismatches = [...versions].filter(([, version]) => version !== expected);
if (mismatches.length) {
  const details = [...versions].map(([file, version]) => `${file}=${version ?? '(없음)'}`).join(', ');
  throw new Error(`버전이 서로 다릅니다: ${details}`);
}

const ref = process.env.GITHUB_REF_NAME || '';
if (/^v\d/.test(ref) && ref.slice(1) !== expected) {
  throw new Error(`릴리스 태그 ${ref}와 앱 버전 ${expected}이 다릅니다.`);
}

console.log(`버전 정합성 확인: ${expected}`);
