'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const {
  shortcutFor,
  normalizeMeasure,
  taskCharAt,
  findTextOffsets,
  textHaystack,
  textRange,
  sessionPlan,
  loadSessionDocuments,
} = require('../renderer/core.js');

function key(keyValue, overrides = {}) {
  const letter = keyValue.length === 1 && /[a-z]/i.test(keyValue)
    ? `Key${keyValue.toUpperCase()}`
    : keyValue;
  return {
    key: keyValue,
    code: letter,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

test('메뉴 단축키를 명령으로 바꾼다', () => {
  const cases = [
    [key('n', { ctrlKey: true }), 'doc:new'],
    [key('o', { ctrlKey: true }), 'files:pick'],
    [key('s', { ctrlKey: true }), 'doc:save'],
    [key('s', { ctrlKey: true, shiftKey: true }), 'doc:save-as'],
    [key('s', { ctrlKey: true, altKey: true }), 'doc:save-all'],
    [key('p', { ctrlKey: true }), 'doc:export-pdf'],
    [key('r', { ctrlKey: true }), 'doc:reload'],
    [key('w', { ctrlKey: true }), 'tab:close'],
    [key('Tab', { code: 'Tab', ctrlKey: true }), 'tab:next'],
    [key('Tab', { code: 'Tab', ctrlKey: true, shiftKey: true }), 'tab:prev'],
    [key('e', { ctrlKey: true }), 'view:mode:toggle'],
    [key('e', { ctrlKey: true, shiftKey: true }), 'view:mode:split'],
    [key('\\', { code: 'Backslash', ctrlKey: true }), 'view:toggle-toc'],
    [key('d', { ctrlKey: true }), 'view:toggle-theme'],
    [key('+', { code: 'Equal', ctrlKey: true, shiftKey: true }), 'view:zoom:in'],
    [key('-', { code: 'Minus', ctrlKey: true }), 'view:zoom:out'],
    [key('0', { code: 'Digit0', ctrlKey: true }), 'view:zoom:reset'],
    [key('f', { metaKey: true }), 'edit:find'],
    [key('F11', { code: 'F11' }), 'view:fullscreen'],
  ];

  for (const [event, expected] of cases) assert.equal(shortcutFor(event), expected);
});

test('한글 IME 자모는 물리 키 위치로 한 번 더 찾는다', () => {
  assert.equal(
    shortcutFor(key('ㄷ', { code: 'KeyE', ctrlKey: true })),
    'view:mode:toggle',
  );
  assert.equal(
    shortcutFor(key('ㄷ', { code: 'KeyE', ctrlKey: true, shiftKey: true })),
    'view:mode:split',
  );
});

test('예약하지 않은 Alt+숫자와 Ctrl+숫자는 전역 명령으로 가로채지 않는다', () => {
  assert.equal(shortcutFor(key('1', { code: 'Digit1', altKey: true })), undefined);
  assert.equal(shortcutFor(key('1', { code: 'Digit1', ctrlKey: true })), undefined);
  assert.equal(shortcutFor(key('n', { altKey: true })), undefined);
});

test('읽기 본문 너비는 허용 범위와 2단위 간격에 맞춘다', () => {
  assert.equal(normalizeMeasure(74), 74);
  assert.equal(normalizeMeasure(75), 76);
  assert.equal(normalizeMeasure(20), 48);
  assert.equal(normalizeMeasure(180), 110);
  assert.equal(normalizeMeasure('98'), 98);
  assert.equal(normalizeMeasure('잘못된 값'), 74);
});

test('읽기 여백 조절 UI에 슬라이더와 세 가지 빠른 설정이 있다', () => {
  const html = readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const doc = new JSDOM(html).window.document;
  const button = doc.getElementById('btn-measure');
  const range = doc.getElementById('measure-range');
  const presets = [...doc.querySelectorAll('#measure-presets button[data-measure]')];

  assert.equal(button.getAttribute('aria-controls'), 'measure-popover');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(range.min, '48');
  assert.equal(range.max, '110');
  assert.equal(range.step, '2');
  assert.deepEqual(presets.map((item) => item.textContent), ['넓게', '기본', '좁게']);
});

test('할 일 항목은 순서·인용·목록 기호와 체크 상태를 정확히 찾는다', () => {
  const source = [
    '- [ ] 첫째',
    '  * [x] 둘째',
    '> 1. [X] 셋째',
    '+ [ ] 넷째',
  ].join('\n');

  const expected = [' ', 'x', 'X', ' '];
  expected.forEach((state, index) => {
    const hit = taskCharAt(source, index);
    assert.ok(hit);
    assert.equal(source[hit.at], state);
    assert.equal(hit.on, state.toLowerCase() === 'x');
  });
  assert.equal(taskCharAt(source, 4), null);
  assert.equal(taskCharAt(source, -1), null);
});

test('코드 울타리 안의 체크박스 표기는 할 일 항목으로 세지 않는다', () => {
  const source = [
    '- [ ] 실제 1',
    '```md',
    '- [x] 코드 예시',
    '```',
    '> - [X] 실제 2',
    '~~~~',
    '1. [ ] 코드 예시',
    '~~~',
    '+ [ ] 코드 안',
    '~~~~',
    '+ [ ] 실제 3',
  ].join('\n');

  assert.equal(source[taskCharAt(source, 0).at], ' ');
  assert.equal(source[taskCharAt(source, 1).at], 'X');
  assert.equal(source[taskCharAt(source, 2).at], ' ');
  assert.equal(taskCharAt(source, 3), null);
});

test('검색은 대소문자 없이 겹치지 않는 위치를 찾고 상한을 지킨다', () => {
  assert.deepEqual(findTextOffsets('Alpha beta BETA betamax', 'beta'), [
    [6, 10],
    [11, 15],
    [16, 20],
  ]);
  assert.deepEqual(findTextOffsets('aaaa', 'aa'), [[0, 2], [2, 4]]);
  assert.deepEqual(findTextOffsets('aaaa', 'a', 2), [[0, 1], [1, 2]]);
  assert.deepEqual(findTextOffsets('본문', '   '), []);
});

test('태그 경계를 가로지르는 검색 결과를 실제 DOM Range로 복원한다', () => {
  const dom = new JSDOM('<article id="doc">alpha <strong>be</strong>ta gamma BETA</article>');
  const doc = dom.window.document;
  const root = doc.getElementById('doc');
  const haystack = textHaystack(root);
  const matches = findTextOffsets(haystack.text, 'beta');
  const ranges = matches.map(([from, to]) => textRange(doc, haystack.nodes, from, to));

  assert.equal(haystack.text, 'alpha beta gamma BETA');
  assert.deepEqual(ranges.map((range) => range.toString()), ['beta', 'BETA']);
});

test('세션 계획은 유효한 경로만 상한까지 복원 대상으로 삼는다', () => {
  assert.deepEqual(
    sessionPlan({ paths: ['a.md', '', null, 'b.md', 'c.md'], active: 'b.md' }, 2),
    { paths: ['a.md', 'b.md'], active: 'b.md', skipped: 1 },
  );
  assert.deepEqual(sessionPlan(null), { paths: [], active: null, skipped: 0 });
});

test('세션 파일 하나가 실패해도 나머지를 순서대로 돌려준다', async () => {
  const started = [];
  const result = await loadSessionDocuments(
    { paths: ['a.md', 'missing.md', 'b.md', 'over-limit.md'], active: 'b.md' },
    async (path) => {
      started.push(path);
      if (path === 'missing.md') throw new Error('없음');
      return { path, text: path };
    },
    3,
  );

  assert.deepEqual(started, ['a.md', 'missing.md', 'b.md']);
  assert.deepEqual(result.documents.map((document) => document.path), ['a.md', 'b.md']);
  assert.equal(result.missing, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.active, 'b.md');
});
