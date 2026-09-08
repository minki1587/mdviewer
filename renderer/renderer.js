'use strict';

/* contextBridge 로 노출된 window.api 는 전역의 non-configurable 프로퍼티라
   최상위 `const api` 선언과 충돌한다(SyntaxError). 전체를 함수로 감싸
   모든 선언을 함수 스코프에 두어 어떤 전역과도 부딪히지 않게 한다. */
(function () {

const api = window.api;
const $ = (sel) => document.querySelector(sel);

const scroller  = $('#scroller');
const docEl     = $('#doc');
const rail      = $('#rail');
const ticksEl   = $('#ticks');
const progress  = $('#progress');
const crumbDir  = $('#crumb-dir');
const tabsEl    = $('#tabs');
const btnToc    = $('#btn-toc');
const btnTheme  = $('#btn-theme');
const modesEl   = $('#modes');
const panes     = $('#panes');
const gutter    = $('#gutter');
const statPos   = $('#stat-pos');
const statCount = $('#stat-count');
const statSave  = $('#stat-save');
const toastEl   = $('#toast');

/* ==================================================================
 * 문서(탭) 모델
 *
 * 편집기 인스턴스는 하나만 두고, 탭마다 EditorState 를 따로 들고 있다가
 * 전환할 때 갈아 끼운다. EditorState 에 본문·커서·되돌리기 기록이 모두
 * 들어 있어서, 탭을 오가도 각 문서의 작업 맥락이 그대로 남는다.
 * 미리보기는 그린 결과(html, 블록 목록, 목차)를 탭에 캐시해 두고
 * 전환할 때 다시 파싱하지 않는다.
 * ================================================================== */

let tabs = [];
let activeId = null;
let seq = 0;
let applying = false;      // 프로그램이 편집기 내용을 바꾸는 중 (사용자 입력 아님)

/* 화면 상태 (문서와 무관하게 앱 전체에 적용) */
let mode  = 'split';       // read | edit | split
let theme = 'light';
let scale = 1;
let pinned = false;
let split = 50;

/* 미리보기 부분 갱신용 — 지금 #doc 에 그려져 있는 블록들 */
let lastBlocks = [];
let lastTocKey = '';
let lastRenderMs = 0;

/* 레일 */
let headings = [];
let tickEls = [];
let anchors = [];

const editor = MDEditor.create({
  parent: $('#editor'),
  doc: '',
  onChange: onEditorChange,
  onScroll: () => syncEditorToPreview(),
  onSave: () => saveActive(),
});

const active = () => tabs.find((t) => t.id === activeId) || null;

function makeTab({ path = null, dir = '', name = '제목 없음', text = '' } = {}) {
  return {
    id: ++seq,
    path, dir, name, text,
    dirty: false,
    state: editor.createState(text),
    html: '', blocks: [], toc: [], tocKey: '',
    stale: true,
    edScroll: 0,
    pvScroll: 0,
  };
}

/* ================================================================== 설정 */

function applyTheme(next) {
  theme = next;
  document.body.dataset.theme = next;
  btnTheme.setAttribute('aria-pressed', String(next === 'dark'));
  btnTheme.title = next === 'dark' ? '밝은 화면 (Ctrl+D)' : '어두운 화면 (Ctrl+D)';
  save();
}

function applyScale(next) {
  scale = Math.min(2.2, Math.max(0.7, Math.round(next * 20) / 20));
  document.documentElement.style.setProperty('--scale', scale);
  updateRail();
  save();
}

function applyPin(next) {
  pinned = next;
  rail.classList.toggle('pinned', pinned);
  document.body.classList.toggle('toc-pinned', pinned);
  btnToc.setAttribute('aria-pressed', String(pinned));
  save();
}

function applySplit(pct) {
  split = Math.min(80, Math.max(20, pct));
  document.documentElement.style.setProperty('--split', `${split}%`);
}

function setMode(next) {
  if (next === 'toggle') next = mode === 'read' ? 'edit' : 'read';
  mode = next;
  document.body.classList.remove('mode-read', 'mode-edit', 'mode-split');
  document.body.classList.add(`mode-${mode}`);
  for (const b of modesEl.children) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));

  const t = active();
  if (t && mode !== 'edit' && t.stale) renderPreview();
  if (mode === 'read') scroller.focus({ preventScroll: true });
  else editor.focus();
  if (mode === 'split') syncEditorToPreview({ force: true });
  updateStatus();
  updateRail();
  save();
}

/* 복원하는 동안에는 세션을 저장하지 않는다. 탭을 하나씩 되살리는 중간에
   저장이 끼어들면 반쪽짜리 목록이 원본을 덮어쓴다. */
let restoring = false;

/* 파일 메뉴의 '최근 문서'. 목록의 주인은 여기이고, 설정과 함께 저장한다.
   메인은 메뉴에 그릴 만큼만 받아 둔다. */
const RECENT_LIMIT = 10;
let recent = [];

function noteRecent(path) {
  /* 세션 복원으로 열리는 것은 '방금 연 문서'가 아니다. 이걸 막지 않으면
     복원할 때마다 목록이 복원 순서로 뒤집히고, 정작 최근에 본 파일이 밀려난다. */
  if (!path || restoring) return;
  const next = [path, ...recent.filter((p) => p !== path)].slice(0, RECENT_LIMIT);
  if (next.length === recent.length && next.every((p, i) => p === recent[i])) return;
  recent = next;
  api.setRecent?.(recent);
  save();
}

/** 다음 실행 때 되살릴 목록. 아직 저장된 적 없는 새 문서는 경로가 없어 빠진다. */
function sessionSnapshot() {
  return {
    paths: tabs.map((t) => t.path).filter(Boolean),
    active: active()?.path || null,
  };
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const patch = { theme, scale, pinned, mode, split, recent };
    /* 복원 중이면 session 키를 아예 빼서 보낸다. 메인의 set_settings 는
       받은 키만 덮어쓰므로, 저장돼 있던 목록이 그대로 남는다. */
    if (!restoring) patch.session = sessionSnapshot();
    api.setSettings(patch);
  }, 250);
}

/* ============================================================== 탭 관리 */

function renderTabs() {
  tabsEl.innerHTML = '';
  for (const t of tabs) {
    const el = document.createElement('div');
    el.className = 'tab';
    el.dataset.id = String(t.id);
    el.draggable = true;
    el.title = t.path || t.name;
    if (t.id === activeId) el.classList.add('active');
    if (t.dirty) el.classList.add('dirty');

    const label = document.createElement('span');
    label.className = 'tab-name';
    label.textContent = t.name;

    const dot = document.createElement('span');
    dot.className = 'tab-dot';

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tab-close';
    close.dataset.close = String(t.id);
    close.setAttribute('aria-label', `${t.name} 닫기`);
    close.textContent = '\u00D7';

    el.append(label, dot, close);
    tabsEl.appendChild(el);
  }

  const current = tabsEl.querySelector('.tab.active');
  if (current) current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  document.body.classList.toggle('many-tabs', tabs.length > 1);

  /* 탭이 열리고·닫히고·순서가 바뀌고·다른 탭으로 옮겨 가는 네 경우가 모두
     여기를 지난다. 세션 저장을 한 곳에 걸기에 알맞다 (save 는 묶어서 늦춘다). */
  save();
}

function activate(id) {
  const prev = active();
  if (prev && prev.id !== id) {
    prev.state = editor.getState();
    prev.edScroll = editor.scrollEl().scrollTop;
    prev.pvScroll = scroller.scrollTop;
  }

  activeId = id;
  const t = active();
  if (!t) return;

  applying = true;
  editor.swapState(t.state);
  applying = false;

  if (t.stale) {
    docEl.innerHTML = '';
    lastBlocks = [];
    lastTocKey = '';
    renderPreview();
  } else {
    docEl.innerHTML = t.html;
    lastBlocks = t.blocks;
    lastTocKey = t.tocKey;
    buildRail(t.toc);
    rebuildAnchors(t.toc);
    refreshFind();     // 탭을 옮기면 들고 있던 Range 가 끊어진 노드를 가리킨다
  }

  renderTabs();
  updateCrumb();
  updateSaved();
  updateStatus();
  reportState();

  // 스크롤 복원은 레이아웃이 잡힌 다음에
  requestAnimationFrame(() => {
    const behavior = scroller.style.scrollBehavior;
    scroller.style.scrollBehavior = 'auto';
    editor.scrollEl().scrollTop = t.edScroll;
    scroller.scrollTop = t.pvScroll;
    scroller.style.scrollBehavior = behavior;
    updateRail();
  });

  if (mode === 'read') scroller.focus({ preventScroll: true });
  else editor.focus();
}

/** 메인에서 파일이 넘어왔을 때 — 이미 열려 있으면 그 탭으로 간다. */
function openPayload(p) {
  if (!p) return;
  noteRecent(p.path);

  const existing = tabs.find((t) => t.path === p.path);
  if (existing) {
    if (!existing.dirty && existing.text !== p.text) replaceContent(existing, p.text);
    activate(existing.id);
    syncWatchList();
    return;
  }

  // 손대지 않은 빈 문서 하나만 있으면 새 탭을 만들지 않고 그 자리에 연다
  const cur = active();
  if (tabs.length === 1 && cur && !cur.path && !cur.dirty && !cur.text) {
    Object.assign(cur, { path: p.path, dir: p.dir, name: p.name, text: p.text, stale: true });
    applying = true;
    editor.swapState(editor.createState(p.text));
    applying = false;
    cur.state = editor.getState();
    activeId = null;
    activate(cur.id);
  } else {
    const t = makeTab(p);
    tabs.push(t);
    activate(t.id);
  }
  syncWatchList();
}

/** 탭의 본문을 통째로 바꾼다 (디스크에서 다시 읽었을 때) */
function replaceContent(t, text) {
  t.text = text;
  t.dirty = false;
  t.stale = true;
  const state = editor.createState(text);
  if (t.id === activeId) {
    applying = true;
    editor.swapState(state);
    applying = false;
    t.state = editor.getState();
    docEl.innerHTML = '';
    lastBlocks = [];
    lastTocKey = '';
    renderPreview();
    updateSaved();
  } else {
    t.state = state;
  }
  renderTabs();
  reportState();
}

function newTab() {
  const t = makeTab();
  tabs.push(t);
  activate(t.id);
  syncWatchList();
  if (mode === 'read') setMode('edit');
}

async function closeTab(id) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return true;
  const t = tabs[i];

  if (t.dirty) {
    const answer = await api.confirmClose(t.name);   // 0 저장 / 1 저장 안 함 / 2 취소
    if (answer === 2) return false;
    if (answer === 0 && !(await saveTab(t))) return false;
  }

  tabs.splice(i, 1);
  if (!tabs.length) tabs.push(makeTab());

  if (activeId === id) {
    activeId = null;
    activate(tabs[Math.min(i, tabs.length - 1)].id);
  } else {
    renderTabs();
  }
  syncWatchList();
  reportState();
  return true;
}

async function closeOthers() {
  for (const t of [...tabs]) {
    if (t.id === activeId) continue;
    if (!(await closeTab(t.id))) return;
  }
}

function step(delta) {
  if (tabs.length < 2) return;
  const i = tabs.findIndex((t) => t.id === activeId);
  activate(tabs[(i + delta + tabs.length) % tabs.length].id);
}

function syncWatchList() {
  api.setWatchList(tabs.map((t) => t.path).filter(Boolean));
}

function reportState() {
  const t = active();
  api.reportState({
    name: t ? t.name : '제목 없음',
    dirty: t ? t.dirty : false,
    dirtyCount: tabs.filter((x) => x.dirty).length,
  });
}

/* ================================================================ 미리보기 */

/**
 * 새 HTML 을 통째로 갈아끼우지 않고, 앞뒤로 같은 부분은 두고
 * 달라진 가운데 블록만 바꾼다. 타이핑 중 화면 깜빡임과 이미지 재로딩을 막는다.
 */
function patchBlocks(html) {
  const staging = document.createElement('div');
  staging.innerHTML = html;
  const next = Array.from(staging.children);
  const nextHtml = next.map((el) => el.outerHTML);

  let head = 0;
  while (head < lastBlocks.length && head < nextHtml.length && lastBlocks[head] === nextHtml[head]) head++;

  let tail = 0;
  while (
    tail < lastBlocks.length - head &&
    tail < nextHtml.length - head &&
    lastBlocks[lastBlocks.length - 1 - tail] === nextHtml[nextHtml.length - 1 - tail]
  ) tail++;

  const current = Array.from(docEl.children);
  const anchorEl = current[current.length - tail] || null;
  for (let i = current.length - tail - 1; i >= head; i--) current[i].remove();

  const frag = document.createDocumentFragment();
  for (let i = head; i < nextHtml.length - tail; i++) frag.appendChild(next[i]);
  docEl.insertBefore(frag, anchorEl);

  lastBlocks = nextHtml;
}

function renderPreview() {
  const t = active();
  if (!t) return;
  const started = performance.now();

  let result;
  try {
    result = api.render(t.text, t.dir);
  } catch (err) {
    docEl.textContent = `문서를 그리지 못했습니다: ${err.message}`;
    return;
  }

  patchBlocks(result.html);

  const tocKey = result.toc.map((x) => `${x.level}:${x.id}`).join('|');
  if (tocKey !== lastTocKey) {
    lastTocKey = tocKey;
    buildRail(result.toc);
  }
  rebuildAnchors(result.toc);

  t.html = docEl.innerHTML;
  t.blocks = lastBlocks;
  t.toc = result.toc;
  t.tocKey = tocKey;
  t.stale = false;

  lastRenderMs = performance.now() - started;
  refreshFind();
  requestAnimationFrame(() => {
    if (mode === 'split') syncEditorToPreview({ force: true });
    updateRail();
  });
}

/** 문서가 클수록 렌더가 오래 걸리므로 대기 시간을 스스로 조절한다. */
let renderTimer = null;
function schedulePreview() {
  if (mode === 'edit') return;          // 안 보이는 화면은 그리지 않는다
  clearTimeout(renderTimer);
  const delay = Math.min(300, Math.max(40, Math.round(lastRenderMs * 1.4)));
  renderTimer = setTimeout(renderPreview, delay);
}

/* ================================================================== 편집 */

function onEditorChange(next) {
  const t = active();
  if (!t) return;
  t.text = next;
  if (applying) return;

  t.stale = true;
  if (!t.dirty) {
    t.dirty = true;
    renderTabs();
    updateSaved();
    reportState();
  }
  schedulePreview();
  updateStatus();
  updateBlank();
}

function updateBlank() {
  const t = active();
  document.body.classList.toggle('blank', !!t && !t.path && !t.text);
}

function updateSaved() {
  const t = active();
  const dirty = !!(t && t.dirty);
  document.body.classList.toggle('unsaved', dirty);
  statSave.textContent = dirty ? '저장 안 됨' : '저장됨';
}

function updateCrumb() {
  const t = active();
  crumbDir.textContent = t && t.dir ? t.dir : '저장하지 않은 문서';
  crumbDir.title = (t && t.path) || '';
  updateBlank();
}

async function saveTab(t, { as = false } = {}) {
  const res = (as || !t.path)
    ? await api.saveFileAs(t.text, t.name)
    : await api.saveFile(t.path, t.text);
  if (!res || !res.ok) return false;

  Object.assign(t, { path: res.path, dir: res.dir, name: res.name, dirty: false, stale: true });
  noteRecent(res.path);           // 새 문서를 처음 저장했거나 다른 이름으로 저장한 경우
  renderTabs();
  reportState();
  syncWatchList();

  if (t.id === activeId) {
    updateCrumb();
    updateSaved();
    if (mode !== 'edit') renderPreview();   // 상대 경로 기준이 바뀔 수 있다
    toast(`${res.name} 저장됨`);
  }
  return true;
}

const saveActive = (opts) => {
  const t = active();
  return t ? saveTab(t, opts) : Promise.resolve(false);
};

async function saveAll() {
  let count = 0;
  for (const t of tabs) {
    if (!t.dirty) continue;
    if (!(await saveTab(t))) return false;
    count++;
  }
  if (count) toast(`${count}개 문서 저장됨`);
  return true;
}

/* ================================================================ 내보내기
 *
 * 종이 배치는 style.css 의 @media print 가 맡는다. 여기서 하는 일은
 * 인쇄 대화상자를 열기 전에 화면과 종이의 차이 세 가지를 메우는 것뿐이다.
 *   1. 편집 중이면 미리보기가 낡아 있다 — 종이에 나갈 것은 그린 결과다.
 *   2. 접어 둔 <details> 는 펼치지 않으면 내용이 통째로 빠진다.
 *   3. lazy 이미지는 아직 화면에 안 나왔으면 빈 자리로 찍힌다.
 *
 * 인쇄 대화상자에서 "PDF로 저장"을 고르면 그대로 PDF 파일이 된다.
 * ------------------------------------------------------------------ */

const MD_SUFFIX = /\.(md|markdown|mdown|mkd|mdtext|mdtxt)$/i;

let exporting = false;

/** 아직 안 실린 이미지를 기다린다. 없거나 늦으면 그냥 진행한다. */
function waitForImages(root, ms = 4000) {
  const pending = [...root.querySelectorAll('img')].filter((img) => !img.complete);
  if (!pending.length) return Promise.resolve();

  const settled = pending.map((img) => new Promise((done) => {
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', done, { once: true });
  }));
  return Promise.race([Promise.all(settled), new Promise((done) => setTimeout(done, ms))]);
}

async function exportPdf() {
  const t = active();
  if (!t || exporting) return;
  if (!t.text.trim()) { toast('내보낼 내용이 없습니다'); return; }

  if (t.stale) renderPreview();

  exporting = true;
  const title = document.title;
  const folded = [...docEl.querySelectorAll('details:not([open])')];
  const lazy = [...docEl.querySelectorAll('img[loading="lazy"]')];

  // 인쇄 대화상자가 제안하는 파일 이름은 document.title 에서 온다
  document.title = t.name.replace(MD_SUFFIX, '') || '제목 없음';
  for (const d of folded) d.open = true;
  for (const img of lazy) img.setAttribute('loading', 'eager');

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    document.title = title;
    for (const d of folded) d.open = false;
    for (const img of lazy) img.setAttribute('loading', 'lazy');
    exporting = false;
  };

  // 인쇄가 끝나면(또는 취소하면) 화면을 원래대로 돌린다.
  // window.print() 는 대화상자가 닫힐 때까지 스크립트를 붙잡아 두므로
  // 보통은 afterprint 가 먼저 오고, 그렇지 않은 런타임을 위해 뒤도 막아 둔다.
  window.addEventListener('afterprint', restore, { once: true });

  try {
    await waitForImages(docEl);
    window.print();
  } catch (err) {
    toast('인쇄를 시작하지 못했습니다');
    restore();
    return;
  }
  setTimeout(restore, 1000);
}

/* 읽는 데 걸리는 시간. 어절/낱말 200개를 1분으로 잡는다 — 한국어 묵독은
   분당 500~700음절이고 한 어절이 대략 세 음절이니 얼추 맞고, 영문 낱말
   기준으로도 흔히 쓰는 200wpm 과 같은 값이라 두 언어에 모두 무난하다. */
function readingMinutes(words) {
  return Math.max(1, Math.round(words / 200));
}

function updateStatus() {
  const s = editor.stats();
  statCount.textContent = `${s.words.toLocaleString()}단어 · ${s.chars.toLocaleString()}자`;
  // 읽기 화면에는 커서가 없다. 그 자리에 읽는 데 걸릴 시간을 둔다.
  statPos.textContent = mode === 'read'
    ? (s.words ? `약 ${readingMinutes(s.words)}분` : '')
    : `${editor.cursorLine()}/${s.lines}줄`;
}

/* ============================================================== 스크롤 동기화
 *
 * 두 화면의 높이 비율만 맞추면 그림이나 코드 블록에서 금방 어긋난다.
 * 그래서 제목을 기준점으로 삼아, 원문의 제목 줄과 미리보기의 제목 위치를
 * 짝지어 두고 그 사이를 비례로 채운다.
 * ------------------------------------------------------------------ */

/** 원문에서 ATX 제목(#)이 있는 줄 번호. 코드 펜스 안쪽은 건너뛴다. */
function headingLines(source) {
  const out = [];
  const lines = source.split('\n');
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const open = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (open) {
      if (!fence) fence = open[1][0];
      else if (line.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (fence) continue;
    if (/^\s{0,3}#{1,6}\s/.test(line)) out.push(i + 1);
  }
  return out;
}

function rebuildAnchors(toc) {
  const t = active();
  const source = headingLines(t ? t.text : '');
  const els = toc.map((x) => document.getElementById(x.id));
  anchors = (els.length === source.length && els.length && els.every(Boolean))
    ? els.map((el, i) => ({ line: source[i], el }))
    : [];   // 짝이 맞지 않으면 비례 방식으로
}

function bounds() {
  return {
    maxTop: Math.max(0, scroller.scrollHeight - scroller.clientHeight),
    lastLine: Math.max(1, editor.lineCount()),
  };
}

function topForLine(line) {
  if (!anchors.length) return null;
  const { maxTop, lastLine } = bounds();
  let prev = { line: 1, top: 0 };
  let next = { line: lastLine, top: maxTop };
  for (const a of anchors) {
    const top = a.el.offsetTop;
    if (a.line <= line) prev = { line: a.line, top };
    else { next = { line: a.line, top }; break; }
  }
  const span = Math.max(1, next.line - prev.line);
  const ratio = Math.min(1, Math.max(0, (line - prev.line) / span));
  return Math.min(maxTop, Math.max(0, prev.top + ratio * (next.top - prev.top)));
}

function lineForTop(top) {
  if (!anchors.length) return null;
  const { maxTop, lastLine } = bounds();
  let prev = { line: 1, top: 0 };
  let next = { line: lastLine, top: maxTop };
  for (const a of anchors) {
    const t = a.el.offsetTop;
    if (t <= top + 1) prev = { line: a.line, top: t };
    else { next = { line: a.line, top: t }; break; }
  }
  const span = Math.max(1, next.top - prev.top);
  const ratio = Math.min(1, Math.max(0, (top - prev.top) / span));
  return prev.line + ratio * (next.line - prev.line);
}

/* 먼저 움직인 쪽이 주도권을 갖고, 손을 뗀 뒤 잠깐 있다가 풀린다.
   이렇게 하지 않으면 두 화면이 서로를 밀며 진동한다. */
let driver = null;
let driverTimer = null;
function claim(who) {
  if (driver && driver !== who) return false;
  driver = who;
  clearTimeout(driverTimer);
  driverTimer = setTimeout(() => { driver = null; }, 160);
  return true;
}

function proportional(src, dst) {
  const a = src.scrollHeight - src.clientHeight;
  const b = dst.scrollHeight - dst.clientHeight;
  if (a <= 0 || b <= 0) return;
  dst.scrollTop = (src.scrollTop / a) * b;
}

function syncEditorToPreview({ force = false } = {}) {
  if (mode !== 'split') return;
  if (force) driver = null;
  if (!claim('editor')) return;

  const behavior = scroller.style.scrollBehavior;
  scroller.style.scrollBehavior = 'auto';
  const top = topForLine(editor.topLine());
  if (top == null) proportional(editor.scrollEl(), scroller);
  else scroller.scrollTop = top;
  scroller.style.scrollBehavior = behavior;
}

function syncPreviewToEditor() {
  if (mode !== 'split' || !claim('preview')) return;
  const line = lineForTop(scroller.scrollTop);
  if (line == null) proportional(scroller, editor.scrollEl());
  else editor.scrollToLine(line);
}

/* ================================================================ 리딩 레일 */

function buildRail(toc) {
  ticksEl.innerHTML = '';
  tickEls = [];
  headings = [];

  toc.forEach((item) => {
    if (item.level > 4) return;          // 레일에는 h4 까지만 (기준점은 h6 까지 씀)
    const target = document.getElementById(item.id);
    if (!target) return;

    const li = document.createElement('li');
    li.className = 'tick';
    li.dataset.level = String(item.level);
    li.title = item.text;

    const dash = document.createElement('span');
    dash.className = 'dash';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = item.text;

    li.append(dash, label);
    li.addEventListener('click', () => target.scrollIntoView({ block: 'start' }));

    ticksEl.appendChild(li);
    tickEls.push(li);
    headings.push(target);
  });

  rail.classList.toggle('has-items', tickEls.length > 0);
}

let railFrame = null;
function updateRail() {
  if (railFrame) return;
  railFrame = requestAnimationFrame(() => {
    railFrame = null;

    const span = scroller.scrollHeight - scroller.clientHeight;
    progress.style.height = `${span > 0 ? (scroller.scrollTop / span) * 100 : 0}%`;

    if (!headings.length) return;
    const line = scroller.scrollTop + 96;
    let current = 0;
    for (let i = 0; i < headings.length; i++) {
      if (headings[i].offsetTop <= line) current = i;
      else break;
    }
    tickEls.forEach((el, i) => el.classList.toggle('current', i === current));
  });
}

scroller.addEventListener('scroll', () => {
  updateRail();
  syncPreviewToEditor();
}, { passive: true });
window.addEventListener('resize', updateRail);

/* ================================================================== 찾기
 *
 * 읽기 화면에서 Ctrl+F. 편집기에는 CodeMirror 의 찾기가 따로 있으므로
 * 여기가 다루는 것은 '이미 그려진 본문'뿐이다.
 *
 * 본문 HTML 은 한 글자도 건드리지 않는다. <mark> 를 끼워 넣으면 미리보기의
 * 블록 비교(patchBlocks)가 매번 어긋나 타이핑 중 화면이 깜빡이고, 다시
 * 그릴 때마다 표시가 날아간다. 대신 CSS Custom Highlight 로 Range 에만
 * 색을 입힌다 — DOM 은 그대로 두고 그리기만 얹는 방식이다.
 * ------------------------------------------------------------------ */

const findEl    = $('#find');
const findInput = $('#find-input');
const findCount = $('#find-count');

/* WebView2 와 Electron 모두 되는 기능이지만, 없으면 예전처럼 편집기 찾기로
   넘긴다. 기능이 빠진 채 조용히 아무 일도 안 하는 것이 제일 나쁘다. */
const HAS_HIGHLIGHT =
  typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight === 'function';

/** 한 글자짜리 검색어가 큰 문서에서 수만 개를 만들지 않도록 막는다. */
const FIND_LIMIT = 2000;

let findRanges = [];
let findIndex = 0;

/** 본문의 모든 텍스트를 한 줄로 잇고, 각 노드가 어디서 시작하는지 적어 둔다. */
function findHaystack() {
  const walker = document.createTreeWalker(docEl, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let text = '';
  let n;
  while ((n = walker.nextNode())) {
    nodes.push({ node: n, start: text.length });
    text += n.nodeValue;
  }
  return { nodes, text };
}

/** 이어붙인 문자열의 [from, to) 를 실제 DOM Range 로 되돌린다.
    한 낱말이 <b> 등으로 쪼개져 여러 노드에 걸쳐 있어도 맞는다. */
function findRange(nodes, from, to) {
  const locate = (pos) => {
    let lo = 0;
    let hi = nodes.length - 1;
    let at = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (nodes[mid].start <= pos) { at = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return [nodes[at].node, pos - nodes[at].start];
  };

  const [sn, so] = locate(from);
  const [en, eo] = locate(to);
  const r = document.createRange();
  r.setStart(sn, Math.min(so, sn.nodeValue.length));
  r.setEnd(en, Math.min(eo, en.nodeValue.length));
  return r;
}

function paintFindMarks() {
  if (!HAS_HIGHLIGHT) return;
  CSS.highlights.delete('mv-find');
  CSS.highlights.delete('mv-find-current');
  if (!findRanges.length) return;

  const rest = findRanges.filter((_, i) => i !== findIndex);
  if (rest.length) CSS.highlights.set('mv-find', new Highlight(...rest));
  CSS.highlights.set('mv-find-current', new Highlight(findRanges[findIndex]));
}

function paintFindCount() {
  const asked = findInput.value.trim().length > 0;
  const n = findRanges.length;
  findCount.textContent = n ? `${findIndex + 1}/${n}` : (asked ? '없음' : '');
  findCount.classList.toggle('none', asked && !n);
}

function scrollToMatch() {
  const r = findRanges[findIndex];
  if (!r) return;
  const rect = r.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  // 화면 밖이거나 가장자리에 걸쳐 있을 때만 움직인다 — 읽던 자리를 흔들지 않는다
  if (rect.top < box.top + 56 || rect.bottom > box.bottom - 36) {
    scroller.scrollTop += rect.top - box.top - box.height / 3;
  }
}

function findRun({ keepIndex = false } = {}) {
  const q = findInput.value;
  const prev = findIndex;
  findRanges = [];
  findIndex = 0;

  if (q.trim()) {
    const { nodes, text } = findHaystack();
    if (nodes.length) {
      const hay = text.toLowerCase();
      const needle = q.toLowerCase();
      let at = hay.indexOf(needle);
      while (at !== -1 && findRanges.length < FIND_LIMIT) {
        findRanges.push(findRange(nodes, at, at + needle.length));
        at = hay.indexOf(needle, at + needle.length);
      }
    }
  }

  if (keepIndex && findRanges.length) findIndex = Math.min(prev, findRanges.length - 1);
  paintFindMarks();
  paintFindCount();
  return findRanges.length;
}

function findGo(delta) {
  if (!findRanges.length) return;
  findIndex = (findIndex + delta + findRanges.length) % findRanges.length;
  paintFindMarks();
  paintFindCount();
  scrollToMatch();
}

function findOpen() {
  findEl.hidden = false;
  findInput.focus();
  findInput.select();
  if (findInput.value.trim() && findRun()) scrollToMatch();
}

function findClose() {
  findEl.hidden = true;
  findRanges = [];
  findIndex = 0;
  if (HAS_HIGHLIGHT) {
    CSS.highlights.delete('mv-find');
    CSS.highlights.delete('mv-find-current');
  }
  if (mode === 'read') scroller.focus({ preventScroll: true });
}

/** 본문이 다시 그려지면 들고 있던 Range 는 끊어진 노드를 가리킨다. 다시 찾는다. */
function refreshFind() {
  if (findEl.hidden) return;
  findRun({ keepIndex: true });
}

findInput.addEventListener('input', () => { if (findRun()) scrollToMatch(); });
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); findGo(e.shiftKey ? -1 : 1); }
  else if (e.key === 'Escape') { e.preventDefault(); findClose(); }
});
$('#find-next').addEventListener('click', () => findGo(1));
$('#find-prev').addEventListener('click', () => findGo(-1));
$('#find-close').addEventListener('click', findClose);

/* =========================================================== 코드 복사
 *
 * 코드 블록마다 단추를 심지 않고, 마우스가 올라간 블록 위로 따라다니는
 * 단추 하나를 쓴다. 본문 DOM 에 무언가를 넣으면 미리보기의 블록 비교가
 * 그려낸 HTML 과 어긋나 타이핑할 때마다 멀쩡한 블록이 다시 그려진다.
 * ------------------------------------------------------------------ */

const copyBtn = $('#copy-code');
let copyTarget = null;
let copyDoneTimer = null;

function hideCopyBtn() {
  copyTarget = null;
  copyBtn.hidden = true;
}

function placeCopyBtn(pre) {
  const r = pre.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  // 블록이 화면 위아래로 거의 빠져나갔으면 단추도 치운다
  if (r.bottom < box.top + 30 || r.top > box.bottom - 10) { hideCopyBtn(); return; }
  copyTarget = pre;
  copyBtn.hidden = false;
  copyBtn.style.top = `${Math.max(r.top + 6, box.top + 6)}px`;
  copyBtn.style.left = `${r.right - 34}px`;
}

scroller.addEventListener('mouseover', (e) => {
  if (e.target.closest('#copy-code')) return;       // 단추 위로 옮겨 가는 중
  const pre = e.target.closest('pre');
  if (pre && docEl.contains(pre)) placeCopyBtn(pre);
  else hideCopyBtn();
});
scroller.addEventListener('mouseleave', hideCopyBtn);
scroller.addEventListener('scroll', () => {
  /* 미리보기가 다시 그려지면 들고 있던 <pre> 는 본문에서 떨어져 나간다.
     떨어진 것을 재면 0 이 나와 단추가 엉뚱한 자리로 간다. */
  if (copyTarget && docEl.contains(copyTarget)) placeCopyBtn(copyTarget);
  else if (copyTarget) hideCopyBtn();
}, { passive: true });

copyBtn.addEventListener('click', async () => {
  // 떨어져 나간 블록에는 옛 내용이 남아 있다. 그걸 복사해 주면 안 된다.
  if (!copyTarget || !docEl.contains(copyTarget)) { hideCopyBtn(); return; }
  const code = copyTarget.querySelector('code') || copyTarget;
  const text = code.textContent;

  let ok = true;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* 클립보드 권한이 막힌 경우를 대비한 옛 방식. 화면 밖에 잠깐 두었다 지운다. */
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    } catch { ok = false; }
  }

  if (!ok) { toast('복사하지 못했습니다'); return; }
  copyBtn.classList.add('done');
  clearTimeout(copyDoneTimer);
  copyDoneTimer = setTimeout(() => copyBtn.classList.remove('done'), 1200);
});

/* ======================================================= 할 일 체크박스
 *
 * 읽기 화면에서 체크박스를 누르면 원문의 그 줄을 고친다. 미리보기의 n번째
 * 할 일 체크박스는 원문의 n번째 할 일 줄과 짝이다 — marked 는 할 일 항목
 * 에만 <li> 첫 자식으로 체크박스를 내고(api 계층이 거기에만 .task 를 붙인다),
 * 그리는 순서는 원문 순서와 같다.
 * ------------------------------------------------------------------ */

/* 인용문 안(`> - [ ]`)도 체크박스로 그려지므로 '>' 를 넘겨 가며 읽는다. */
const TASK_LINE = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)([ xX])(?=\])/;

/* 코드 울타리. 안쪽의 `- [ ]` 는 글자 그대로 나오지 세어야 할 항목이 아니다.
   이걸 빼먹으면 세는 수가 어긋나 엉뚱한 줄이 바뀐다 — 마크다운 문법을
   설명하는 문서에서 실제로 일어난다. */
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/** 원문에서 n번째 할 일 항목의 상태 글자가 몇 번째 글자인지. 없으면 -1. */
function taskCharAt(text, nth) {
  const lines = text.split('\n');
  let seen = -1;
  let offset = 0;          // 문서 처음부터 이 줄 앞까지의 글자 수
  let fence = null;        // 열려 있는 울타리의 표시 문자열

  for (const line of lines) {
    const f = line.match(FENCE);
    if (f) {
      if (!fence) fence = f[1];
      // 닫는 울타리는 같은 문자로 열 때만큼 길거나 더 길어야 한다
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
    } else if (!fence) {
      const m = line.match(TASK_LINE);
      if (m && ++seen === nth) {
        return { at: offset + m[1].length, on: m[2].toLowerCase() === 'x' };
      }
    }
    offset += line.length + 1;          // +1 은 줄바꿈
  }
  return null;
}

function toggleTask(box) {
  const t = active();
  if (!t) return;

  const nth = [...docEl.querySelectorAll('input.task')].indexOf(box);
  if (nth < 0) return;

  const hit = taskCharAt(t.text, nth);
  if (!hit) return;
  editor.replaceRange(hit.at, hit.at + 1, hit.on ? ' ' : 'x');
}

docEl.addEventListener('click', (e) => {
  const box = e.target.closest('input.task');
  if (!box) return;
  /* 기본 동작을 막지 않는다. 눌린 표시는 바로 나타나고, 잠시 뒤 원문을
     고쳐 다시 그린 결과도 같은 상태라 깜빡이지 않는다. 막아 두면 미리보기
     갱신이 늦어지는 만큼 눌러도 반응이 없는 것처럼 보인다. */
  toggleTask(box);
});

/* ================================================================== 알림 */

let toastTimer = null;
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1800);
}

/* ================================================================== 도움말
 *
 * 문법 목록을 글로만 늘어놓으면 결국 결과를 상상해야 한다.
 * 그래서 각 항목을 이 앱의 렌더링 파이프라인에 그대로 태워서,
 * 왼쪽에는 쓰는 법을, 오른쪽에는 실제로 나오는 모양을 함께 보여준다.
 * ------------------------------------------------------------------ */

const helpEl    = $('#help');
const helpBody  = $('#help-body');
const helpTabs  = $('#help-tabs');
const helpSearch = $('#help-search');
let helpPage = 'syntax';

function buildSyntaxList(query) {
  const frag = document.createDocumentFragment();
  let shown = 0;

  for (const section of window.HELP_SYNTAX) {
    const items = section.items.filter((it) =>
      !query || (it.syntax + ' ' + it.desc + ' ' + section.group).toLowerCase().includes(query));
    if (!items.length) continue;

    const h = document.createElement('h3');
    h.className = 'help-group';
    h.textContent = section.group;
    frag.appendChild(h);

    for (const it of items) {
      shown++;
      const row = document.createElement('div');
      row.className = 'help-row';

      const left = document.createElement('div');
      left.className = 'help-left';

      const code = document.createElement('code');
      code.className = 'help-syntax';
      code.textContent = it.syntax;

      const desc = document.createElement('p');
      desc.className = 'help-desc';
      desc.textContent = it.desc;

      const insert = document.createElement('button');
      insert.type = 'button';
      insert.className = 'help-insert';
      insert.textContent = '넣기';
      insert.title = '커서 자리에 예시를 넣습니다';
      insert.addEventListener('click', () => {
        if (mode === 'read') setMode('split');
        editor.insert(it.sample);
        closeHelp();
        toast('예시를 넣었습니다');
      });

      left.append(code, desc, insert);

      const preview = document.createElement('div');
      preview.className = 'help-preview markdown';
      try {
        preview.innerHTML = api.render(it.demo || it.sample, '').html;
      } catch {
        preview.textContent = '(미리보기를 그리지 못했습니다)';
      }

      row.append(left, preview);
      frag.appendChild(row);
    }
  }

  if (!shown) {
    const none = document.createElement('p');
    none.className = 'help-none';
    none.textContent = '찾는 내용이 없습니다.';
    frag.appendChild(none);
  }
  return frag;
}

function buildKeyList(query) {
  const frag = document.createDocumentFragment();
  let shown = 0;

  for (const section of window.HELP_KEYS) {
    const rows = section.rows.filter(([k, d]) =>
      !query || (k + ' ' + d + ' ' + section.group).toLowerCase().includes(query));
    if (!rows.length) continue;

    const h = document.createElement('h3');
    h.className = 'help-group';
    h.textContent = section.group;
    frag.appendChild(h);

    for (const [keys, what] of rows) {
      shown++;
      const row = document.createElement('div');
      row.className = 'help-key';

      const k = document.createElement('span');
      k.className = 'help-keycap';
      k.textContent = keys;

      const d = document.createElement('span');
      d.className = 'help-what';
      d.textContent = what;

      row.append(k, d);
      frag.appendChild(row);
    }
  }

  if (!shown) {
    const none = document.createElement('p');
    none.className = 'help-none';
    none.textContent = '찾는 내용이 없습니다.';
    frag.appendChild(none);
  }
  return frag;
}

function paintHelp() {
  const query = helpSearch.value.trim().toLowerCase();
  helpBody.innerHTML = '';
  helpBody.scrollTop = 0;
  helpBody.appendChild(helpPage === 'keys' ? buildKeyList(query) : buildSyntaxList(query));
  for (const b of helpTabs.children) b.setAttribute('aria-pressed', String(b.dataset.help === helpPage));
}

function openHelp(page = 'syntax') {
  helpPage = page;
  helpEl.hidden = false;
  paintHelp();
  helpSearch.focus();
}

function closeHelp() {
  helpEl.hidden = true;
  helpSearch.value = '';
}

helpTabs.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-help]');
  if (!b) return;
  helpPage = b.dataset.help;
  paintHelp();
});
helpSearch.addEventListener('input', paintHelp);
$('#help-close').addEventListener('click', closeHelp);
$('#btn-help').addEventListener('click', () => openHelp('syntax'));
helpEl.addEventListener('mousedown', (e) => { if (e.target === helpEl) closeHelp(); });
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !helpEl.hidden) { e.preventDefault(); closeHelp(); return; }
  // 찾기 상자 밖에 초점이 있어도 Esc 로 닫히게 한다
  if (e.key === 'Escape' && !findEl.hidden) { e.preventDefault(); findClose(); }
}, true);

/* ================================================================ 업데이트
 *
 * 메인이 보내는 상태를 그대로 받아 오른쪽 아래에 카드로 보여준다.
 * 조용한 확인(자동)에서는 새 버전이 있을 때만 나타나고,
 * 메뉴에서 직접 확인했을 때는 결과를 항상 알려준다.
 * ------------------------------------------------------------------ */

const updateEl      = $('#update');
const updateTitle   = $('#update-title');
const updateNote    = $('#update-note');
const updateTrack   = $('#update-track');
const updateFill    = $('#update-fill');
const updateActions = $('#update-actions');

let updateHideTimer = null;

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

function hideUpdate() {
  clearTimeout(updateHideTimer);
  updateEl.hidden = true;
}

function updateButton(label, { primary = false, onClick }) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = primary ? 'update-btn primary' : 'update-btn';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function showUpdate(state) {
  clearTimeout(updateHideTimer);
  updateActions.innerHTML = '';
  updateNote.textContent = '';
  updateTrack.hidden = true;
  updateEl.hidden = false;

  switch (state.status) {
    case 'checking':
      updateTitle.textContent = '업데이트 확인 중…';
      break;

    case 'available':
      updateTitle.textContent = `새 버전 ${state.version}`;
      updateNote.textContent = '내려받아 다시 시작하면 설치됩니다.';
      updateActions.append(
        updateButton('내려받기', { primary: true, onClick: () => api.downloadUpdate() }),
        updateButton('나중에', { onClick: hideUpdate }),
      );
      break;

    case 'downloading': {
      updateTitle.textContent = `내려받는 중 ${state.percent}%`;
      updateNote.textContent = state.total
        ? `${mb(state.transferred)} / ${mb(state.total)}`
        : '';
      updateTrack.hidden = false;
      updateFill.style.width = `${state.percent}%`;
      break;
    }

    case 'ready':
      updateTitle.textContent = `${state.version} 설치 준비 완료`;
      updateNote.textContent = '지금 다시 시작하거나, 다음에 앱을 닫을 때 설치됩니다.';
      updateActions.append(
        updateButton('지금 다시 시작', {
          primary: true,
          onClick: async () => {
            if (tabs.some((t) => t.dirty) && !(await saveAll())) return;
            api.installUpdate();
          },
        }),
        updateButton('나중에', { onClick: hideUpdate }),
      );
      break;

    case 'none':
      updateTitle.textContent = '최신 버전입니다';
      updateNote.textContent = `현재 ${state.version}`;
      updateHideTimer = setTimeout(hideUpdate, 3200);
      break;

    case 'dev':
      updateTitle.textContent = '개발 모드';
      updateNote.textContent = '설치된 앱에서만 업데이트를 확인합니다.';
      updateHideTimer = setTimeout(hideUpdate, 3800);
      break;

    case 'unconfigured':
      updateTitle.textContent = '저장소가 지정되지 않았습니다';
      updateNote.textContent = 'package.json 의 build.publish 를 채워야 확인할 수 있습니다.';
      updateHideTimer = setTimeout(hideUpdate, 5000);
      break;

    case 'error':
      updateTitle.textContent = '업데이트를 확인하지 못했습니다';
      updateNote.textContent = state.message || '';
      updateActions.append(
        updateButton('다시 시도', { onClick: () => api.checkUpdate() }),
        updateButton('닫기', { onClick: hideUpdate }),
      );
      break;

    default:
      hideUpdate();
  }
}

$('#update-dismiss').addEventListener('click', hideUpdate);

api.onUpdateState((state) => {
  // 조용한 확인에서는 알릴 거리가 있을 때만 띄운다
  const quiet = !state.manual;
  if (quiet && ['checking', 'none', 'error', 'dev', 'unconfigured'].includes(state.status)) return;
  showUpdate(state);
});

/* ================================================================== 링크 */

docEl.addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a) return;
  e.preventDefault();

  if (a.dataset.anchor) {
    const target = document.getElementById(a.dataset.anchor);
    if (target) target.scrollIntoView({ block: 'start' });
    return;
  }
  if (a.dataset.external) return void api.openExternal(a.dataset.external);
  if (a.dataset.mdPath)   return void api.openPath(a.dataset.mdPath);   // 새 탭으로
  if (a.dataset.filePath) return void api.openLocal(a.dataset.filePath);
});

/* ============================================================= 드래그 & 드롭 */

let dragDepth = 0;
const setDragging = (on) => document.body.classList.toggle('dragging', on);

/* 편집기(CodeMirror)는 자체 드롭 처리를 갖고 있어서, 파일을 떨어뜨리면
   내용을 본문에 텍스트로 붙여 넣는다. 그래서 파일 드래그일 때만
   캡처 단계에서 가로채 편집기까지 내려가지 않게 한다.
   탭을 끌어 옮길 때는 'Files' 가 아니므로 여기에 걸리지 않는다. */
const isFileDrag = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');

function grab(e) {
  e.preventDefault();
  e.stopPropagation();
}

window.addEventListener('dragenter', (e) => {
  if (!isFileDrag(e)) return;
  grab(e); dragDepth++; setDragging(true);
}, true);

window.addEventListener('dragover', (e) => {
  if (!isFileDrag(e)) return;
  grab(e);
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
}, true);

window.addEventListener('dragleave', (e) => {
  if (!isFileDrag(e)) return;
  grab(e);
  if (--dragDepth <= 0) { dragDepth = 0; setDragging(false); }
}, true);

window.addEventListener('drop', (e) => {
  if (!isFileDrag(e)) return;
  grab(e);
  dragDepth = 0;
  setDragging(false);
  const paths = Array.from(e.dataTransfer?.files || [])
    .map((f) => api.pathForFile(f))
    .filter(Boolean);
  if (paths.length) api.openPath(paths);     // 여러 개를 한꺼번에 열 수 있다
}, true);

/* ================================================================ 탭 조작 */

tabsEl.addEventListener('click', (e) => {
  const closeBtn = e.target.closest('[data-close]');
  if (closeBtn) { closeTab(Number(closeBtn.dataset.close)); return; }
  const tab = e.target.closest('.tab');
  if (tab) activate(Number(tab.dataset.id));
});

tabsEl.addEventListener('auxclick', (e) => {
  if (e.button !== 1) return;              // 가운데 버튼으로 닫기
  const tab = e.target.closest('.tab');
  if (tab) { e.preventDefault(); closeTab(Number(tab.dataset.id)); }
});

tabsEl.addEventListener('wheel', (e) => {
  if (e.deltaY === 0) return;
  tabsEl.scrollLeft += e.deltaY;           // 세로 휠로 탭 줄을 좌우로
}, { passive: true });

$('#tab-new').addEventListener('click', () => newTab());

/* 탭 순서 바꾸기 */
let dragTabId = null;
tabsEl.addEventListener('dragstart', (e) => {
  const el = e.target.closest('.tab');
  if (!el) return;
  dragTabId = Number(el.dataset.id);
  el.classList.add('moving');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', el.dataset.id);
});
tabsEl.addEventListener('dragend', () => {
  dragTabId = null;
  tabsEl.querySelectorAll('.moving').forEach((el) => el.classList.remove('moving'));
});
tabsEl.addEventListener('dragover', (e) => {
  if (dragTabId == null) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
});
tabsEl.addEventListener('drop', (e) => {
  if (dragTabId == null) return;
  e.preventDefault();
  const over = e.target.closest('.tab');
  const from = tabs.findIndex((t) => t.id === dragTabId);
  if (from < 0) return;
  let to = over ? tabs.findIndex((t) => t.id === Number(over.dataset.id)) : tabs.length - 1;
  if (to < 0 || to === from) return;
  if (over) {
    const box = over.getBoundingClientRect();
    if (e.clientX > box.left + box.width / 2 && to < from) to++;
    if (e.clientX < box.left + box.width / 2 && to > from) to--;
  }
  const [moved] = tabs.splice(from, 1);
  tabs.splice(to, 0, moved);
  renderTabs();
});

/* ============================================================ 창 나누기 손잡이 */

gutter.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  gutter.setPointerCapture(e.pointerId);
  document.body.classList.add('resizing');
});
gutter.addEventListener('pointermove', (e) => {
  if (!document.body.classList.contains('resizing')) return;
  const rect = panes.getBoundingClientRect();
  applySplit(((e.clientX - rect.left) / rect.width) * 100);
});
gutter.addEventListener('pointerup', (e) => {
  gutter.releasePointerCapture(e.pointerId);
  document.body.classList.remove('resizing');
  save();
});
gutter.addEventListener('dblclick', () => { applySplit(50); save(); });

/* ================================================================== 입력 */

$('#btn-open').addEventListener('click', () => api.pickFiles());
$('#btn-new').addEventListener('click', () => newTab());
$('#empty-open').addEventListener('click', () => api.pickFiles());
btnTheme.addEventListener('click', () => applyTheme(theme === 'dark' ? 'light' : 'dark'));
btnToc.addEventListener('click', () => applyPin(!pinned));
$('#btn-export').addEventListener('click', () => exportPdf());
modesEl.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (b) setMode(b.dataset.mode);
});

scroller.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  applyScale(scale + (e.deltaY < 0 ? 0.05 : -0.05));
}, { passive: false });

document.addEventListener('selectionchange', () => {
  if (mode !== 'read') updateStatus();
});

window.addEventListener('keydown', (e) => {
  // Alt+숫자로 탭 이동 (Ctrl+숫자는 편집기의 제목 단축키라 비워 둔다)
  if (e.altKey && !e.ctrlKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
    const i = Number(e.key) - 1;
    if (tabs[i]) { e.preventDefault(); activate(tabs[i].id); }
    return;
  }
  if (e.target !== scroller) return;
  if (e.key === 'Home' && !e.ctrlKey) { scroller.scrollTo({ top: 0 }); e.preventDefault(); }
  if (e.key === 'End'  && !e.ctrlKey) { scroller.scrollTo({ top: scroller.scrollHeight }); e.preventDefault(); }
  if (e.key === ' ') {
    e.preventDefault();
    scroller.scrollBy({ top: scroller.clientHeight * (e.shiftKey ? -0.88 : 0.88) });
  }
});

/* ========================================================= 메인에서 오는 신호 */

api.onOpen(openPayload);

api.onFileChanged((payload) => {
  const t = tabs.find((x) => x.path === payload.path);
  if (!t) return;
  if (t.dirty) {
    toast(`${t.name} 이 다른 곳에서 바뀌었습니다 — Ctrl+R 로 다시 불러오세요`);
    return;
  }
  replaceContent(t, payload.text);
});

api.onSaveAllQuit(async () => { if (await saveAll()) api.forceQuit(); });

/* ================================================================== 명령
 *
 * 메뉴 클릭과 단축키가 모두 이 함수 하나로 들어온다.
 *
 * 단축키를 여기서 받는 이유: Rust 메뉴에 붙인 액셀러레이터는 WebView2 가
 * 창 안의 키 입력을 먼저 가져가는 탓에 발화하지 않는다. 메뉴를 마우스로
 * 누르면 되는데 같은 항목의 단축키만 죽어 있던 것이 그 증상이었다.
 * 메뉴의 단축키 표시는 그대로 두고(보여 줄 것은 있어야 한다), 실제 처리는
 * 키가 실제로 도착하는 웹뷰 안에서 한다.
 * ------------------------------------------------------------------ */

/* 같은 명령이 두 경로로 겹쳐 들어오는 것을 막는다. 지금은 액셀러레이터가
   죽어 있어 겹칠 일이 없지만, 나중에 되살아나면 키 한 번에 두 번 실행된다.
   출처가 서로 다른 같은 명령만 걸러 낸다 — 사용자가 같은 키를 연달아
   누르는 것(Ctrl+N 두 번)은 막지 않는다. */
const lastCommand = new Map();

function isEcho(name, source) {
  const prev = lastCommand.get(name);
  const now = performance.now();
  lastCommand.set(name, { source, at: now });
  return !!prev && prev.source !== source && now - prev.at < 250;
}

async function runCommand(name, source = 'menu') {
  if (isEcho(name, source)) return;
  const t = active();
  switch (name) {
    /* 파일 */
    case 'doc:new':      newTab(); break;
    case 'files:pick':   api.pickFiles(); break;
    case 'doc:save':     saveActive(); break;
    case 'doc:save-as':  saveActive({ as: true }); break;
    case 'doc:save-all': saveAll(); break;
    case 'doc:export-pdf': exportPdf(); break;
    case 'doc:reveal':   if (t?.path) api.reveal(t.path); break;
    case 'doc:reload': {
      if (!t?.path) break;
      if (t.dirty && (await api.confirmClose(t.name)) === 2) break;
      const fresh = await api.readFile(t.path);
      if (fresh) replaceContent(t, fresh.text);
      break;
    }
    /* 탭 */
    case 'tab:close':        closeTab(activeId); break;
    case 'tab:close-others': closeOthers(); break;
    case 'tab:next':         step(+1); break;
    case 'tab:prev':         step(-1); break;
    /* 편집 */
    case 'edit:undo':   editor.undo(); break;
    case 'edit:redo':   editor.redo(); break;
    /* 읽는 중에는 그려진 본문에서 찾는다. 예전에는 여기서 나란히 보기로
       바꿔 버려, 읽기만 하려던 사람 앞에 편집기가 튀어나왔다. */
    case 'edit:find':
      if (mode === 'read' && HAS_HIGHLIGHT) findOpen();
      else { if (mode === 'read') setMode('split'); editor.find(); }
      break;
    case 'edit:bold':   editor.bold(); break;
    case 'edit:italic': editor.italic(); break;
    case 'edit:link':   editor.link(); break;
    /* 보기 — 예전에는 onZoom/onMode 처럼 따로 오던 신호였다.
       단축키와 메뉴가 같은 이름을 쓰도록 여기로 모았다. */
    case 'view:mode:toggle':  setMode('toggle'); break;
    case 'view:mode:split':   setMode(mode === 'split' ? 'read' : 'split'); break;
    case 'view:zoom:in':      applyScale(scale + 0.1); break;
    case 'view:zoom:out':     applyScale(scale - 0.1); break;
    case 'view:zoom:reset':   applyScale(1); break;
    case 'view:toggle-toc':   applyPin(!pinned); break;
    case 'view:toggle-theme': applyTheme(theme === 'dark' ? 'light' : 'dark'); break;
    case 'view:fullscreen':   api.toggleFullscreen(); break;
    case 'view:devtools':     api.toggleDevtools(); break;
    /* 도움말 */
    case 'help:syntax': openHelp('syntax'); break;
    case 'help:keys':   openHelp('keys'); break;
  }
}

api.onCommand((name) => runCommand(name, 'menu'));
api.onZoom((delta) => runCommand(
  delta === 0 ? 'view:zoom:reset' : delta > 0 ? 'view:zoom:in' : 'view:zoom:out', 'menu'));
api.onToggleToc(() => runCommand('view:toggle-toc', 'menu'));
api.onToggleTheme(() => runCommand('view:toggle-theme', 'menu'));
api.onMode((next) => runCommand(
  next === 'split' ? 'view:mode:split' : 'view:mode:toggle', 'menu'));

/* ------------------------------------------------------------ 단축키 표
 *
 * 메뉴에 적힌 조합과 같아야 한다. 편집기가 이미 쓰는 키(Ctrl+B/I/K/S 등)도
 * 표에 있지만, CodeMirror 가 먼저 처리하면서 preventDefault 를 걸기 때문에
 * 편집 중에는 편집기가 이기고 읽기 모드에서만 이 표가 맡는다.
 */
const SHORTCUTS = {
  'Ctrl+N': 'doc:new',
  'Ctrl+O': 'files:pick',
  'Ctrl+S': 'doc:save',
  'Ctrl+Shift+S': 'doc:save-as',
  'Ctrl+Alt+S': 'doc:save-all',
  'Ctrl+P': 'doc:export-pdf',
  'Ctrl+R': 'doc:reload',
  'Ctrl+W': 'tab:close',
  'Ctrl+Tab': 'tab:next',
  'Ctrl+Shift+Tab': 'tab:prev',
  'Ctrl+E': 'view:mode:toggle',
  'Ctrl+Shift+E': 'view:mode:split',
  'Ctrl+\\': 'view:toggle-toc',
  'Ctrl+D': 'view:toggle-theme',
  'Ctrl+=': 'view:zoom:in',
  'Ctrl+Shift+=': 'view:zoom:in',
  'Ctrl+-': 'view:zoom:out',
  'Ctrl+0': 'view:zoom:reset',
  'Ctrl+F': 'edit:find',
  'Ctrl+Z': 'edit:undo',
  'Ctrl+Shift+Z': 'edit:redo',
  'Ctrl+B': 'edit:bold',
  'Ctrl+I': 'edit:italic',
  'Ctrl+K': 'edit:link',
  'F1': 'help:syntax',
  'F11': 'view:fullscreen',
  'F12': 'view:devtools',
};

/** 눌린 조합을 'Ctrl+Shift+S' 같은 한 줄로 만든다. */
function comboOf(e) {
  let key = e.key;
  if (key === '+') key = '=';               // Shift 를 낀 '=' 는 '+' 로 온다
  if (key.length === 1) key = key.toUpperCase();
  return withMods(e, key);
}

/* 한글 입력 상태에서 e.key 가 자모로 오는 자판·런타임이 있다 — 그러면
   Ctrl+E 가 'Ctrl+ㄷ' 이 되어 표에서 찾지 못한다. 위에서 못 찾았을 때만
   자판의 물리 위치로 한 번 더 찾는다. 먼저 하지 않는 이유는, 물리 위치를
   앞세우면 Dvorak 처럼 자판을 바꿔 쓰는 사람의 기대와 어긋나기 때문이다. */
function comboByCode(e) {
  const m = /^Key([A-Z])$/.exec(e.code) || /^Digit([0-9])$/.exec(e.code);
  return m ? withMods(e, m[1]) : null;
}

function withMods(e, key) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

window.addEventListener('keydown', (e) => {
  // 편집기나 모달이 이미 처리한 키는 건드리지 않는다
  if (e.defaultPrevented) return;
  // 저장 여부를 묻는 모달이 떠 있는 동안은 뒤쪽 화면을 조작하지 않는다
  if (document.querySelector('.mv-modal-back')) return;

  const byCode = comboByCode(e);
  const name = SHORTCUTS[comboOf(e)] || (byCode ? SHORTCUTS[byCode] : undefined);
  if (!name) return;

  /* 찾기 상자나 도움말 검색창에 글을 쓰는 중이라면 되돌리기·다시 실행은
     그 입력칸의 것이어야 한다. 저장·탭 이동 같은 나머지는 그대로 통한다. */
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
  if (typing && (name === 'edit:undo' || name === 'edit:redo')) return;

  /* WebView2 의 기본 동작을 반드시 막아야 하는 것들이 섞여 있다.
     Ctrl+R 은 페이지를 새로 고쳐 열려 있는 탭을 통째로 날리고,
     Ctrl+P / Ctrl+F 는 웹뷰 자체의 인쇄·찾기를 연다. */
  e.preventDefault();
  runCommand(name, 'key');
});

/* ================================================================== 시작 */

/** 지난 번에 열려 있던 문서를 되살린다. */
const SESSION_LIMIT = 30;

async function restoreSession(session) {
  const all = Array.isArray(session?.paths) ? session.paths : [];
  const paths = all.slice(0, SESSION_LIMIT);
  /* 넘치는 것은 되살리지 않는다. 그런데 되살린 직후 세션을 다시 저장하므로
     여기서 말해 주지 않으면 남은 탭이 조용히 사라진 것처럼 보인다. */
  const skipped = all.length - paths.length;
  if (!paths.length) return;

  restoring = true;
  let missing = 0;
  try {
    // 한 줄씩 기다리면 파일이 많을 때 창 뜨는 것이 늦어진다. 읽기는 한꺼번에,
    // 탭으로 만드는 것은 저장된 순서대로 한다.
    const docs = await Promise.all(
      paths.map((p) => Promise.resolve(api.readFile(p)).catch(() => null)),
    );
    for (const doc of docs) {
      if (doc) openPayload(doc);
      else missing++;
    }
    const target = tabs.find((t) => t.path === session.active);
    if (target) activate(target.id);
  } finally {
    restoring = false;
  }

  save();

  // 말없이 빠뜨리면 사용자는 탭이 준 줄도 모른다
  const notes = [];
  if (missing) notes.push(`${missing}개를 찾지 못했습니다`);
  if (skipped) notes.push(`${skipped}개는 너무 많아 열지 않았습니다`);
  if (notes.length) toast(`이전에 열려 있던 문서 ${notes.join(', ')}`);
}

(async () => {
  let saved = {};
  try { saved = (await api.getSettings()) || {}; } catch {}

  const systemDark = await api.systemPrefersDark().catch(() => false);
  applyTheme(saved.theme || (systemDark ? 'dark' : 'light'));
  applyScale(typeof saved.scale === 'number' ? saved.scale : 1);
  applyPin(Boolean(saved.pinned));
  applySplit(typeof saved.split === 'number' ? saved.split : 50);

  recent = Array.isArray(saved.recent) ? saved.recent.slice(0, RECENT_LIMIT) : [];
  api.setRecent?.(recent);

  const first = makeTab();
  tabs.push(first);
  activate(first.id);

  setMode(['read', 'edit', 'split'].includes(saved.mode) ? saved.mode : 'split');

  /* ready() 보다 먼저 되살린다. ready() 를 받은 메인이 명령줄로 넘어온 파일을
     보내오는데, 그 파일이 마지막에 열려야 활성 탭이 된다 — .md 를 더블클릭해
     실행했으면 그 문서를 보고 싶지, 어제 보던 탭을 보고 싶지는 않다. */
  /* 복원이 어떤 이유로 실패해도 앱은 떠야 한다. 여기서 예외가 새어 나가면
     ready() 에 닿지 못해, 창은 메인의 3초 안전장치로만 뜨고 명령줄로 넘어온
     파일은 영영 열리지 않는다. 진단하기 가장 어려운 실패 방식이다. */
  try {
    await restoreSession(saved.session);
  } catch (err) {
    console.error('세션 복원 실패:', err);
    toast('지난 세션을 되살리지 못했습니다');
  }

  api.ready();
})();

})();
