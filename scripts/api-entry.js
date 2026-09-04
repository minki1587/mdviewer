/* ------------------------------------------------------------------ *
 * window.api — Electron preload 이 하던 일을 Tauri 위에서 그대로 한다.
 *
 * renderer.js 는 이 객체 하나만 보고 동작하므로, 표면을 똑같이 맞춰 두면
 * 화면 쪽 코드는 손댈 곳이 없다. 달라진 점은 두 가지뿐이다.
 *   - 마크다운 변환이 preload(Node) 가 아니라 웹 계층에서 일어난다.
 *   - 로컬 이미지는 file:// 대신 Tauri 의 asset 프로토콜을 거친다.
 *     (WebView2 는 http 출처에서 file:// 을 읽지 못한다)
 *
 * 결과물: renderer/vendor/api.js  (renderer.js 보다 먼저 실행되어야 한다)
 * ------------------------------------------------------------------ */

import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';

import { marked } from 'marked';
import hljs from 'highlight.js';
// ESM 빌드는 window 에 묶인 인스턴스를 기본 내보내기로 준다.
// 혹시 팩토리가 오더라도 받아 낼 수 있게 한 번 확인한다.
import _dp from 'dompurify';

const DOMPurify = typeof _dp.sanitize === 'function' ? _dp : _dp(window);

marked.setOptions({ gfm: true, breaks: false, pedantic: false });

const MD_EXTS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mdtext', '.mdtxt']);
const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

/* ------------------------------------------------------------------ *
 * 윈도우 경로 다루기
 *
 * 웹 계층에는 node 의 path 가 없다. 상대 이미지·링크를 문서 폴더 기준으로
 * 풀어 주는 데 필요한 만큼만 직접 만든다.
 * ------------------------------------------------------------------ */

const DRIVE = /^[a-zA-Z]:[\\/]/;
const UNC = /^[\\/]{2}/;

function normalize(p) {
  const win = p.replace(/\//g, '\\');
  const root = (/^([a-zA-Z]:\\|\\\\|\\)/.exec(win) || ['', ''])[1];
  const parts = [];
  for (const seg of win.slice(root.length).split(/\\+/)) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (parts.length && parts[parts.length - 1] !== '..') parts.pop();
      else if (!root) parts.push('..');
    } else {
      parts.push(seg);
    }
  }
  return root + parts.join('\\');
}

function resolvePath(baseDir, rel) {
  if (DRIVE.test(rel) || UNC.test(rel)) return normalize(rel);
  if (/^[\\/]/.test(rel)) {
    const drive = (/^([a-zA-Z]:)/.exec(baseDir) || ['', ''])[1];
    return normalize(drive + rel);
  }
  return normalize(`${baseDir}\\${rel}`);
}

function extname(p) {
  const base = p.split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot) : '';
}

/* ------------------------------------------------------------------ *
 * 마크다운 -> { html, toc }
 * (preload 판과 같은 규칙. 이미지 주소를 만드는 부분만 다르다)
 * ------------------------------------------------------------------ */

/** 상대 경로를 문서 폴더 기준 절대 경로로 바꾼다. */
function resolveLocal(ref, baseDir) {
  if (!ref || !baseDir || ABSOLUTE.test(ref)) return null;
  let decoded = ref;
  try { decoded = decodeURIComponent(ref); } catch {}
  const [clean] = decoded.split('#');
  return resolvePath(baseDir, clean);
}

/** 제목 텍스트 -> 앵커 id (GitHub 규칙에 가깝게, 한글 유지) */
function slugify(text, used) {
  let base = text
    .toLowerCase()
    .trim()
    .replace(/[\s]+/g, '-')
    .replace(/[^\p{L}\p{N}\-_]/gu, '');
  if (!base) base = 'section';
  let slug = base;
  let n = 1;
  while (used.has(slug)) slug = `${base}-${n++}`;
  used.add(slug);
  return slug;
}

function highlight(codeEl) {
  const langClass = [...codeEl.classList].find((c) => c.startsWith('language-'));
  const lang = langClass ? langClass.slice(9).toLowerCase() : null;
  const source = codeEl.textContent;
  try {
    const result = lang && hljs.getLanguage(lang)
      ? hljs.highlight(source, { language: lang, ignoreIllegals: true })
      : hljs.highlightAuto(source);
    codeEl.innerHTML = result.value;         // hljs 출력은 이스케이프된 안전한 HTML
    codeEl.classList.add('hljs');
    if (result.language) codeEl.dataset.lang = result.language;
  } catch {
    codeEl.classList.add('hljs');
  }
}

function render(markdown, baseDir) {
  const rawHtml = marked.parse(markdown ?? '');
  const safeHtml = DOMPurify.sanitize(rawHtml, {
    ADD_ATTR: ['align', 'target', 'rel', 'id', 'start', 'colspan', 'rowspan'],
    ADD_TAGS: ['details', 'summary'],
  });

  const doc = new DOMParser().parseFromString(`<div id="__root">${safeHtml}</div>`, 'text/html');
  const root = doc.getElementById('__root');

  // 1) 코드 하이라이팅 + 언어 라벨
  root.querySelectorAll('pre > code').forEach(highlight);

  // 2) 제목 id 부여 + 목차 수집
  const toc = [];
  const used = new Set();
  root.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h) => {
    const text = h.textContent.trim();
    const id = h.id || slugify(text, used);
    h.id = id;
    toc.push({ id, text, level: Number(h.tagName[1]) });
  });

  // 3) 이미지 경로 해석 — asset 프로토콜을 거쳐야 WebView2 가 읽는다
  root.querySelectorAll('img').forEach((img) => {
    const abs = resolveLocal(img.getAttribute('src'), baseDir);
    if (abs) img.setAttribute('src', convertFileSrc(abs));
    img.setAttribute('loading', 'lazy');
  });

  // 4) 링크 분류: 외부 / 로컬 마크다운 / 로컬 파일 / 앵커
  root.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    if (href.startsWith('#')) {
      let frag = href.slice(1);
      try { frag = decodeURIComponent(frag); } catch {}
      a.dataset.anchor = frag;
      return;
    }
    if (/^(https?|mailto):/i.test(href)) { a.dataset.external = href; return; }
    const abs = resolveLocal(href, baseDir);
    if (!abs) return;
    if (MD_EXTS.has(extname(abs).toLowerCase())) a.dataset.mdPath = abs;
    else a.dataset.filePath = abs;
  });

  // 5) 체크박스는 읽기 전용
  root.querySelectorAll('input[type="checkbox"]').forEach((el) => {
    el.setAttribute('disabled', '');
  });

  return { html: root.innerHTML, toc };
}

/* ------------------------------------------------------------------ *
 * 이벤트 구독
 *
 * listen() 은 비동기라 등록이 끝나기 전에 백엔드가 먼저 보낼 수 있다.
 * ready() 가 등록이 모두 끝난 뒤에 백엔드를 깨우도록 약속을 모아 둔다.
 *
 * 구독자를 여기에도 들고 있는 이유는 단축키 때문이다. 아래 wireKeys 를 보라.
 * ------------------------------------------------------------------ */
const subscribing = [];
const subscribers = new Map();          // 이벤트 이름 -> 콜백들

function on(event, handler) {
  const list = subscribers.get(event) || [];
  list.push(handler);
  subscribers.set(event, list);
  subscribing.push(listen(event, (e) => deliver(event, e.payload)));
}

/** 백엔드에서 왔든 키보드에서 왔든 같은 자리로 흘려보낸다. */
function deliver(event, payload) {
  for (const handler of subscribers.get(event) || []) handler({ payload });
}

/** 메뉴에서 오는 문서/탭 명령은 이름이 그대로 이벤트가 되어 온다. */
const COMMANDS = [
  'doc:new', 'doc:save', 'doc:save-as', 'doc:save-all', 'doc:reload', 'doc:reveal',
  'tab:close', 'tab:close-others', 'tab:next', 'tab:prev',
  'edit:undo', 'edit:redo', 'edit:find', 'edit:bold', 'edit:italic', 'edit:link',
  'help:syntax', 'help:keys',
];

/* ------------------------------------------------------------------ *
 * 단축키
 *
 * Electron 은 메뉴에 붙인 accelerator 가 창 전체에서 먹었지만, WebView2 에
 * 초점이 있을 때는 창의 accelerator 표까지 키가 내려가지 않는다. 그래서
 * 메뉴 쪽에는 보이기용 힌트만 두고, 실제 판정은 여기서 한다.
 * 화면 전체에서 키를 한 곳에서만 해석하므로 두 번 실행될 일이 없다.
 *
 * 거품 단계에서 듣고 defaultPrevented 를 먼저 살핀다. CodeMirror 가 이미
 * 처리한 키(Ctrl+B, Ctrl+F, Ctrl+Z …)를 가로채지 않기 위해서다.
 * ------------------------------------------------------------------ */

/** [ctrl, shift, alt, 키] -> 할 일 */
const KEYS = [
  ['c..', 'n', () => deliver('doc:new')],
  ['c..', 'o', () => invoke('pick_files')],
  ['c..', 's', () => deliver('doc:save')],
  ['cs.', 's', () => deliver('doc:save-as')],
  ['c.a', 's', () => deliver('doc:save-all')],
  ['c..', 'r', () => deliver('doc:reload')],
  ['c..', 'w', () => deliver('tab:close')],

  ['c..', 'z', () => deliver('edit:undo')],
  ['cs.', 'z', () => deliver('edit:redo')],
  ['c..', 'y', () => deliver('edit:redo')],
  ['c..', 'f', () => deliver('edit:find')],
  ['c..', 'b', () => deliver('edit:bold')],
  ['c..', 'i', () => deliver('edit:italic')],
  ['c..', 'k', () => deliver('edit:link')],

  ['c..', 'e', () => deliver('view:mode', 'toggle')],
  ['cs.', 'e', () => deliver('view:mode', 'split')],
  ['c..', 'tab', () => deliver('tab:next')],
  ['cs.', 'tab', () => deliver('tab:prev')],

  ['c..', '=', () => deliver('view:zoom', 1)],
  ['c..', '+', () => deliver('view:zoom', 1)],
  ['c..', '-', () => deliver('view:zoom', -1)],
  ['c..', '0', () => deliver('view:zoom', 0)],

  ['c..', '\\', () => deliver('view:toggle-toc')],
  ['c..', 'd', () => deliver('view:toggle-theme')],

  ['...', 'f1', () => deliver('help:syntax')],
  ['...', 'f12', () => invoke('toggle_devtools')],
];

function wireKeys() {
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;              // CodeMirror 가 이미 처리했다
    const mods = `${e.ctrlKey || e.metaKey ? 'c' : '.'}${e.shiftKey ? 's' : '.'}${e.altKey ? 'a' : '.'}`;
    const key = e.key.toLowerCase();
    for (const [want, k, run] of KEYS) {
      if (want !== mods || k !== key) continue;
      e.preventDefault();
      e.stopPropagation();
      run();
      return;
    }
  });
}

/* ------------------------------------------------------------------ *
 * 파일 끌어다 놓기
 *
 * WebView2 는 HTML5 드롭에서 실제 경로를 주지 않는다. 대신 Tauri 가
 * 창 단위로 경로가 붙은 이벤트를 보내 준다. 화면 표시(.dragging)는
 * renderer.js 가 하던 것과 같게 맞춘다.
 * ------------------------------------------------------------------ */
function wireDragDrop() {
  const mark = (on) => document.body.classList.toggle('dragging', on);
  subscribing.push(
    getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === 'enter' || payload.type === 'over') return mark(true);
      if (payload.type === 'leave') return mark(false);
      if (payload.type === 'drop') {
        mark(false);
        const paths = (payload.paths || []).filter(Boolean);
        if (paths.length) invoke('open_paths', { paths });
      }
    })
  );
}

/* ------------------------------------------------------------------ *
 * 공개 API
 * ------------------------------------------------------------------ */
window.api = {
  render,

  ready: () => {
    wireDragDrop();
    wireKeys();
    Promise.allSettled(subscribing).then(() => invoke('app_ready'));
  },

  /* ---- 파일 ---- */
  pickFiles: () => invoke('pick_files'),
  openPath: (p) => invoke('open_paths', { paths: Array.isArray(p) ? p : [p] }),
  readFile: (p) => invoke('read_doc', { path: p }),
  saveFile: (path, text) => invoke('save_file', { path: path ?? null, text }),
  saveFileAs: (text, name) => invoke('save_file_as', { text, name: name ?? null }),
  setWatchList: (paths) => invoke('set_watch_list', { paths: (paths || []).filter(Boolean) }),
  confirmClose: (name) => invoke('confirm_close', { name }),

  /* ---- 상태 보고 ---- */
  reportState: (state) => invoke('set_doc_state', { state }),
  forceQuit: () => invoke('force_quit'),

  /* ---- 바깥으로 ---- */
  openExternal: (url) => invoke('open_external', { url }),
  openLocal: (p) => invoke('open_local', { path: p }),
  reveal: (p) => (p ? invoke('reveal', { path: p }) : undefined),

  /* ---- 업데이트 ---- */
  appVersion: () => invoke('app_version'),
  updateState: () => invoke('update_state'),
  checkUpdate: () => invoke('update_check'),
  downloadUpdate: () => invoke('update_download'),
  installUpdate: () => invoke('update_install'),
  onUpdateState: (cb) => on('update:state', (e) => cb(e.payload)),

  /* ---- 설정 ---- */
  getSettings: () => invoke('get_settings'),
  setSettings: (patch) => invoke('set_settings', { patch }),
  systemPrefersDark: () => invoke('system_prefers_dark'),

  /* ---- 끌어다 놓기 ----
     Tauri 가 경로를 직접 주므로 File 객체에서 뽑을 일이 없다.
     renderer.js 의 HTML5 드롭 경로는 이 환경에서 실행되지 않는다. */
  pathForFile: () => null,

  /* ---- 백엔드에서 오는 신호 ---- */
  onOpen: (cb) => on('tab:open', (e) => cb(e.payload)),
  onFileChanged: (cb) => on('file:changed', (e) => cb(e.payload)),
  onSaveAllQuit: (cb) => on('app:save-all-quit', () => cb()),
  onZoom: (cb) => on('view:zoom', (e) => cb(e.payload)),
  onToggleToc: (cb) => on('view:toggle-toc', () => cb()),
  onToggleTheme: (cb) => on('view:toggle-theme', () => cb()),
  onMode: (cb) => on('view:mode', (e) => cb(e.payload)),

  onCommand: (cb) => {
    for (const name of COMMANDS) on(name, () => cb(name));
  },
};
