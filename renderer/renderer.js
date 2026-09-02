'use strict';

const api = window.api;
const $ = (sel) => document.querySelector(sel);

const scroller  = $('#scroller');
const docEl     = $('#doc');
const rail      = $('#rail');
const ticksEl   = $('#ticks');
const progress  = $('#progress');
const crumbName = $('#crumb-name');
const crumbDir  = $('#crumb-dir');
const dot       = $('#dot');
const btnToc    = $('#btn-toc');
const btnTheme  = $('#btn-theme');
const modesEl   = $('#modes');
const panes     = $('#panes');
const gutter    = $('#gutter');
const statPos   = $('#stat-pos');
const statCount = $('#stat-count');
const statSave  = $('#stat-save');
const toastEl   = $('#toast');

/* 문서 상태 */
let filePath = null;
let fileDir  = '';
let fileName = '제목 없음';
let text     = '';
let dirty    = false;
let previewStale = true;
let applying = false;      // 프로그램이 편집기 내용을 바꾸는 중 (사용자 입력 아님)

/* 화면 상태 */
let mode  = 'split';          // read | edit | split
let theme = 'light';
let scale = 1;
let pinned = false;
let split = 50;

/* 레일 */
let headings = [];
let tickEls = [];

const editor = MDEditor.create({
  parent: $('#editor'),
  doc: '',
  onChange: onEditorChange,
  onScroll: () => syncEditorToPreview(),
  onSave: () => saveDoc(),
});

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
  for (const b of modesEl.children) {
    b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  }

  if (mode !== 'edit' && previewStale) renderPreview();
  if (mode === 'read') scroller.focus({ preventScroll: true });
  else editor.focus();
  if (mode === 'split') syncEditorToPreview({ force: true });
  updateStatus();
  updateRail();
  save();
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.setSettings({ theme, scale, pinned, mode, split }), 250);
}

/* ================================================================ 문서 표시 */

let lastBlocks = [];   // 직전에 그린 최상위 블록들의 HTML
let lastTocKey = '';

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
  previewStale = false;
  const started = performance.now();

  let result;
  try {
    result = api.render(text, fileDir);
  } catch (err) {
    docEl.textContent = `문서를 그리지 못했습니다: ${err.message}`;
    return;
  }

  patchBlocks(result.html);

  const tocKey = result.toc.map((t) => `${t.level}:${t.id}`).join('|');
  if (tocKey !== lastTocKey) {
    lastTocKey = tocKey;
    buildRail(result.toc);
  }
  rebuildAnchors(result.toc);

  lastRenderMs = performance.now() - started;
  requestAnimationFrame(() => {
    if (mode === 'split') syncEditorToPreview({ force: true });
    updateRail();
  });
}

/** 문서가 클수록 렌더가 오래 걸리므로 대기 시간을 스스로 조절한다. */
let renderTimer = null;
let lastRenderMs = 0;
function schedulePreview() {
  previewStale = true;
  if (mode === 'edit') return;          // 안 보이는 화면은 그리지 않는다
  clearTimeout(renderTimer);
  const delay = Math.min(300, Math.max(40, Math.round(lastRenderMs * 1.4)));
  renderTimer = setTimeout(renderPreview, delay);
}

/** 새 파일이 열렸을 때 (메인 프로세스에서 옴) */
function loadDoc(payload) {
  const sameFile = filePath === payload.path;
  filePath = payload.path;
  fileDir  = payload.dir;
  fileName = payload.name;
  text     = payload.text;

  applying = true;
  editor.setDoc(text, { reset: !sameFile });
  applying = false;
  setDirty(false);
  document.body.classList.remove('blank');
  updateCrumb();

  const keep = payload.keepScroll && sameFile ? scroller.scrollTop : 0;
  if (!sameFile) { lastBlocks = []; lastTocKey = ''; docEl.innerHTML = ''; }
  previewStale = true;
  renderPreview();
  scroller.style.scrollBehavior = 'auto';
  scroller.scrollTop = keep;
  requestAnimationFrame(() => { scroller.style.scrollBehavior = ''; });

  updateStatus();
}

/** 빈 문서로 시작 */
function loadNew() {
  filePath = null;
  fileDir  = '';
  fileName = '제목 없음';
  text     = '';
  applying = true;
  editor.setDoc('', { reset: true });
  applying = false;
  setDirty(false);
  document.body.classList.remove('blank');
  updateCrumb();
  lastBlocks = [];
  lastTocKey = '';
  docEl.innerHTML = '';
  renderPreview();
  if (mode === 'read') setMode('edit');
  else editor.focus();
  updateStatus();
}

function updateCrumb() {
  crumbName.textContent = fileName;
  crumbDir.textContent = fileDir;
  crumbDir.title = filePath || '';
}

/* ================================================================== 편집 */

function onEditorChange(next) {
  text = next;
  if (applying) return;    // 파일을 불러오며 채운 내용은 수정으로 치지 않는다
  setDirty(true);
  schedulePreview();
  updateStatus();
}

function setDirty(next) {
  if (dirty === next) return;
  dirty = next;
  dot.hidden = !next;
  document.body.classList.toggle('unsaved', next);
  statSave.textContent = next ? '저장 안 됨' : '저장됨';
  api.setDirty(next);
}

async function saveDoc({ as = false } = {}) {
  const res = as ? await api.saveFileAs(text) : await api.saveFile(filePath, text);
  if (!res || !res.ok) return false;

  filePath = res.path;
  fileDir  = res.dir;
  fileName = res.name;
  setDirty(false);
  updateCrumb();
  previewStale = true;
  if (mode !== 'edit') renderPreview();   // 상대 경로 기준이 바뀔 수 있다
  toast(`${res.name} 저장됨`);
  return true;
}

function updateStatus() {
  if (mode === 'read') return;
  const s = editor.stats();
  statCount.textContent = `${s.words.toLocaleString()}단어 · ${s.chars.toLocaleString()}자`;
  statPos.textContent = `${editor.cursorLine()}/${s.lines}줄`;
}

/* ============================================================== 스크롤 동기화
 *
 * 두 화면의 높이 비율만 맞추면 그림이나 코드 블록에서 금방 어긋난다.
 * 그래서 제목을 기준점으로 삼아, 원문의 제목 줄과 미리보기의 제목 위치를
 * 짝지어 두고 그 사이를 비례로 채운다. 제목이 없는 문서에서는 전체 비율로
 * 되돌아간다.
 * ------------------------------------------------------------------ */

let anchors = [];   // [{ line, el }]

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
  const source = headingLines(text);
  const els = toc.map((t) => document.getElementById(t.id));
  anchors = (els.length === source.length && els.every(Boolean))
    ? els.map((el, i) => ({ line: source[i], el }))
    : [];   // 짝이 맞지 않으면 비례 방식으로
}

function bounds() {
  return {
    maxTop: Math.max(0, scroller.scrollHeight - scroller.clientHeight),
    lastLine: Math.max(1, editor.lineCount()),
  };
}

/** 원문 줄 번호 -> 미리보기 스크롤 위치 */
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

/** 미리보기 스크롤 위치 -> 원문 줄 번호 */
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
  if (force) { driver = null; }
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
    let active = 0;
    for (let i = 0; i < headings.length; i++) {
      if (headings[i].offsetTop <= line) active = i;
      else break;
    }
    tickEls.forEach((el, i) => el.classList.toggle('current', i === active));
  });
}

scroller.addEventListener('scroll', () => {
  updateRail();
  syncPreviewToEditor();
}, { passive: true });
window.addEventListener('resize', updateRail);

/* ================================================================== 알림 */

let toastTimer = null;
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1800);
}

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
  if (a.dataset.mdPath)   return void api.openPath(a.dataset.mdPath);
  if (a.dataset.filePath) return void api.openLocal(a.dataset.filePath);
});

/* ============================================================= 드래그 & 드롭 */

let dragDepth = 0;
const setDragging = (on) => document.body.classList.toggle('dragging', on);

window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; setDragging(true); });
window.addEventListener('dragover',  (e) => { e.preventDefault(); });
window.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; setDragging(false); } });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  setDragging(false);
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  const p = api.pathForFile(file);
  if (p) api.openPath(p);
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

$('#btn-open').addEventListener('click', () => api.openDialog());
$('#empty-open').addEventListener('click', () => api.openDialog());
$('#empty-new').addEventListener('click', () => api.newFile());
btnTheme.addEventListener('click', () => applyTheme(theme === 'dark' ? 'light' : 'dark'));
btnToc.addEventListener('click', () => applyPin(!pinned));
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
  if (e.key === 'Home' && !e.ctrlKey && e.target === scroller) { scroller.scrollTo({ top: 0 }); e.preventDefault(); }
  if (e.key === 'End'  && !e.ctrlKey && e.target === scroller) { scroller.scrollTo({ top: scroller.scrollHeight }); e.preventDefault(); }
  if (e.key === ' ' && e.target === scroller) {
    e.preventDefault();
    scroller.scrollBy({ top: scroller.clientHeight * (e.shiftKey ? -0.88 : 0.88) });
  }
});

/* ========================================================= 메인에서 오는 신호 */

api.onFile(loadDoc);
api.onNewFile(loadNew);
api.onZoom((delta) => applyScale(delta === 0 ? 1 : scale + delta * 0.1));
api.onToggleToc(() => applyPin(!pinned));
api.onToggleTheme(() => applyTheme(theme === 'dark' ? 'light' : 'dark'));
api.onMode((next) => setMode(next === 'split' && mode === 'split' ? 'read' : next));
api.onSave(() => saveDoc());
api.onSaveAs(() => saveDoc({ as: true }));

api.onSaveThen(async (pending) => {
  if (!(await saveDoc())) return;
  if (pending.open) api.openPath(pending.open);
  else if (pending.quit) api.forceQuit();
  else if (pending.fresh) api.newFile();
});

api.onChangedOutside(() => {
  toast('이 파일이 다른 곳에서 바뀌었습니다 — Ctrl+R 로 다시 불러오세요');
});

api.onEditCommand((name) => {
  if (name === 'find' && mode === 'read') setMode('split');
  switch (name) {
    case 'undo':   editor.undo(); break;
    case 'redo':   editor.redo(); break;
    case 'find':   editor.find(); break;
    case 'bold':   editor.bold(); break;
    case 'italic': editor.italic(); break;
    case 'link':   editor.link(); break;
  }
});

/* ================================================================== 시작 */

(async () => {
  let saved = {};
  try { saved = (await api.getSettings()) || {}; } catch {}

  const systemDark = await api.systemPrefersDark().catch(() => false);
  applyTheme(saved.theme || (systemDark ? 'dark' : 'light'));
  applyScale(typeof saved.scale === 'number' ? saved.scale : 1);
  applyPin(Boolean(saved.pinned));
  applySplit(typeof saved.split === 'number' ? saved.split : 50);
  setMode(['read', 'edit', 'split'].includes(saved.mode) ? saved.mode : 'split');

  api.ready();
})();
