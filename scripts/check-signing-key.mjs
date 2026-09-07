/* 업데이터 서명 키가 쓸 수 있는 상태인지 빌드 전에 확인한다.
 *
 * 이 검사가 없으면 어긋난 키는 2분짜리 Rust 빌드와 NSIS 패키징을 모두
 * 끝낸 뒤에야 번들러 깊은 곳에서 드러난다. 실제로 그렇게 두 번 잃었다.
 *   1차: 시크릿 값이 UTF-8 BOM 으로 시작 -> "Invalid symbol 239, offset 0"
 *   2차: 키 암호 불일치            -> "Wrong password for that key"
 *
 * 게다가 그 둘을 통과해도 함정이 하나 더 남는다. 서명에 쓴 키가
 * tauri.conf.json 의 pubkey 와 다른 키면 빌드도 릴리스도 멀쩡히 끝나지만,
 * 설치된 앱은 서명을 검증하지 못해 업데이트를 거부한다. 발행한 뒤에야
 * 알게 되는 종류의 실패다. 그래서 여기서 시험 서명을 한 번 만들고,
 * 그 서명의 키 ID 가 앱이 신뢰하는 공개키와 같은지까지 본다.
 *
 * 키 값 자체는 어디에도 찍지 않는다. 서명과 키 ID 는 공개 정보다.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CONF = new URL('../src-tauri/tauri.conf.json', import.meta.url);

/** GitHub Actions 는 ::error:: 로 시작하는 줄을 실행 화면에 띄운다. */
function fail(message) {
  console.log(`::error::${message}`);
  process.exit(1);
}

/** minisign 공개키/서명 블록에서 키 ID 를 꺼낸다.
    앞 2바이트가 알고리즘, 이어지는 8바이트가 키 ID(리틀엔디언)다. */
function keyId(base64Block) {
  const raw = Buffer.from(base64Block, 'base64');
  return Buffer.from(raw.subarray(2, 10)).reverse().toString('hex').toUpperCase();
}

const key = process.env.TAURI_SIGNING_PRIVATE_KEY ?? '';

if (!key) {
  fail(
    'TAURI_SIGNING_PRIVATE_KEY 시크릿이 비어 있습니다. ' +
    '개인키 파일 내용을 저장소 Settings > Secrets and variables > Actions 에 넣으세요.',
  );
}

if (key.charCodeAt(0) === 0xfeff || Buffer.from(key, 'utf8').subarray(0, 3).toString('hex') === 'efbbbf') {
  fail(
    'TAURI_SIGNING_PRIVATE_KEY 값이 UTF-8 BOM 으로 시작합니다. base64 디코딩이 첫 글자에서 실패합니다. ' +
    '메모장이나 PowerShell 리디렉션을 거치지 말고 파일 내용을 그대로 다시 넣으세요.',
  );
}

/* 앱이 신뢰하는 공개키 — 이 키로 서명하지 않으면 설치된 앱이 업데이트를 거부한다. */
const conf = JSON.parse(readFileSync(CONF, 'utf8'));
const pubkeyField = conf.plugins?.updater?.pubkey;
if (!pubkeyField) fail('tauri.conf.json 에 plugins.updater.pubkey 가 없습니다.');

const pubkeyText = Buffer.from(pubkeyField, 'base64').toString('utf8');
const pubkeyBlock = pubkeyText.split('\n').find((l) => l && !l.startsWith('untrusted'));
if (!pubkeyBlock) fail('tauri.conf.json 의 pubkey 를 읽지 못했습니다.');
const wantId = keyId(pubkeyBlock.trim());

/* 시험 서명 — 키와 암호가 실제로 맞는지 여기서 드러난다. */
const dir = mkdtempSync(join(tmpdir(), 'mv-signcheck-'));
const probe = join(dir, 'probe.txt');
writeFileSync(probe, 'signing key probe\n');

try {
  execFileSync('npx', ['tauri', 'signer', 'sign', probe], {
    stdio: ['ignore', 'ignore', 'pipe'],
    shell: process.platform === 'win32',
    env: process.env,                   // 키와 암호는 환경변수로만 넘어간다
  });
} catch (err) {
  const detail = String(err.stderr || err.message).split('\n').slice(-4).join(' ').trim();
  rmSync(dir, { recursive: true, force: true });

  if (/password/i.test(detail)) {
    fail(
      '개인키 암호가 맞지 않습니다. TAURI_SIGNING_PRIVATE_KEY_PASSWORD 시크릿을 ' +
      '키를 만들 때 쓴 암호로 맞추세요. 암호 없는 키라면 그 시크릿을 지우세요 ' +
      `(빈 값이어야 합니다). 원문: ${detail}`,
    );
  }
  fail(`시험 서명에 실패했습니다: ${detail}`);
}

const sigText = Buffer.from(readFileSync(`${probe}.sig`, 'utf8'), 'base64').toString('utf8');
const sigBlock = sigText.split('\n').find((l) => l.startsWith('RU'));
rmSync(dir, { recursive: true, force: true });

if (!sigBlock) fail('시험 서명 결과를 읽지 못했습니다.');
const gotId = keyId(sigBlock.trim());

if (gotId !== wantId) {
  fail(
    `서명 키가 앱이 신뢰하는 공개키와 다릅니다. 시크릿의 키 ID 는 ${gotId} 인데 ` +
    `tauri.conf.json 의 pubkey 는 ${wantId} 입니다. 이대로 발행하면 빌드는 성공하지만 ` +
    '설치된 앱이 서명을 검증하지 못해 업데이트를 거부합니다. ' +
    `${wantId} 짝인 개인키를 시크릿에 넣거나, 키를 바꿀 거라면 pubkey 도 함께 바꾸세요 ` +
    '(이미 설치된 판은 그 릴리스로 자동 갱신되지 않습니다).',
  );
}

console.log(`서명 키 확인됨 — 키 ID ${gotId}, 암호 일치, pubkey 와 짝이 맞습니다.`);
