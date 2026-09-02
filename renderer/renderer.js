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

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.setSettings({ theme, scale, pinned, mode, split }), 250);
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
  if (e.key === 'Escape' && !helpEl.hidden) { e.preventDefault(); closeHelp(); }
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

api.onZoom((delta) => applyScale(delta === 0 ? 1 : scale + delta * 0.1));
api.onToggleToc(() => applyPin(!pinned));
api.onToggleTheme(() => applyTheme(theme === 'dark' ? 'light' : 'dark'));
api.onMode((next) => setMode(next === 'split' && mode === 'split' ? 'read' : next));
api.onSaveAllQuit(async () => { if (await saveAll()) api.forceQuit(); });

api.onCommand(async (name) => {
  const t = active();
  switch (name) {
    case 'doc:new':      newTab(); break;
    case 'doc:save':     saveActive(); break;
    case 'doc:save-as':  saveActive({ as: true }); break;
    case 'doc:save-all': saveAll(); break;
    case 'doc:reveal':   if (t?.path) api.reveal(t.path); break;
    case 'doc:reload': {
      if (!t?.path) break;
      if (t.dirty && (await api.confirmClose(t.name)) === 2) break;
      const fresh = await api.readFile(t.path);
      if (fresh) replaceContent(t, fresh.text);
      break;
    }
    case 'tab:close':        closeTab(activeId); break;
    case 'tab:close-others': closeOthers(); break;
    case 'tab:next':         step(+1); break;
    case 'tab:prev':         step(-1); break;
    case 'edit:undo':   editor.undo(); break;
    case 'edit:redo':   editor.redo(); break;
    case 'edit:find':   if (mode === 'read') setMode('split'); editor.find(); break;
    case 'edit:bold':   editor.bold(); break;
    case 'edit:italic': editor.italic(); break;
    case 'edit:link':   editor.link(); break;
    case 'help:syntax': openHelp('syntax'); break;
    case 'help:keys':   openHelp('keys'); break;
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

  const first = makeTab();
  tabs.push(first);
  activate(first.id);

  setMode(['read', 'edit', 'split'].includes(saved.mode) ? saved.mode : 'split');
  api.ready();
})();

})();
