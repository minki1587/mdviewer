/* ------------------------------------------------------------------ *
 * window.api — Electron preload.js 를 Tauri 위에서 그대로 재현한다.
 *
 * renderer.js 는 한 줄도 고치지 않는다. 그래서 여기서 노출하는 함수의
 * 이름·인자·반환 모양을 preload.js 와 정확히 같게 맞춘다.
 *
 * Electron 과 다른 점은 세 가지뿐이고, 모두 이 파일 안에서 흡수한다.
 *   1. node:path 가 없으므로 경로 조작을 직접 구현한다.
 *   2. 로컬 이미지는 file:// 대신 Tauri 의 asset 프로토콜로 바꾼다.
 *   3. 네이티브 3버튼 대화상자가 없으므로 HTML 모달로 만든다.
 * ------------------------------------------------------------------ */

import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';

import { marked } from 'marked';
import hljs from 'highlight.js';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: false, pedantic: false });

const MD_EXTS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mdtext', '.mdtxt']);
const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

/* ----------------------------------------------------------- 경로 유틸
   node:path 대신 쓰는 최소 구현. Windows 구분자와 ../ 를 다룬다. */

const SEP = /[\\/]/;

function basename(p) {
  const parts = String(p).split(SEP);
  return parts[parts.length - 1] || '';
}

function extname(p) {
  const base = basename(p);
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i);
}

/** baseDir 기준 상대 경로를 절대 경로로 편다. */
function resolvePath(baseDir, ref) {
  const isUnc = /^\\\\/.test(baseDir);
  const segments = String(baseDir).split(SEP).concat(String(ref).split(SEP));
  const out = [];
  for (const seg of segments) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return (isUnc ? '\\\\' : '') + out.join('\\');
}

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

/** 마크다운 -> { html, toc } */
function render(markdown, baseDir) {
  const rawHtml = marked.parse(markdown ?? '');
  const safeHtml = DOMPurify.sanitize(rawHtml, {
    ADD_ATTR: ['align', 'target', 'rel', 'id', 'start', 'colspan', 'rowspan'],
    ADD_TAGS: ['details', 'summary'],
  });

  const doc = new DOMParser().parseFromString(`<div id="__root">${safeHtml}</div>`, 'text/html');
  const root = doc.getElementById('__root');

  root.querySelectorAll('pre > code').forEach(highlight);

  const toc = [];
  const used = new Set();
  root.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h) => {
    const text = h.textContent.trim();
    const id = h.id || slugify(text, used);
    h.id = id;
    toc.push({ id, text, level: Number(h.tagName[1]) });
  });

  // Electron 은 file:// 을 그대로 썼지만, WebView2 에서는 asset 프로토콜을 거쳐야 한다
  root.querySelectorAll('img').forEach((img) => {
    const abs = resolveLocal(img.getAttribute('src'), baseDir);
    if (abs) img.setAttribute('src', convertFileSrc(abs));
    img.setAttribute('loading', 'lazy');
  });

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

  root.querySelectorAll('input[type="checkbox"]').forEach((el) => {
    el.setAttribute('disabled', '');
  });

  return { html: root.innerHTML, toc };
}

/* ------------------------------------------------------------- 모달
   Tauri 의 다이얼로그 플러그인은 버튼 두 개까지만 지원한다.
   저장 / 저장 안 함 / 취소 세 갈래가 필요하므로 직접 만든다.
   반환값은 Electron 판과 같게 0 / 1 / 2 이다. */

const MODAL_CSS = `
.mv-modal-back{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;
  justify-content:center;background:rgba(0,0,0,.42)}
.mv-modal{min-width:340px;max-width:min(560px,88vw);padding:20px 22px 16px;border-radius:10px;
  background:var(--surface,#fff);color:var(--ink,#1a1a1a);
  box-shadow:0 18px 48px rgba(0,0,0,.34);font-family:var(--font-body,system-ui,sans-serif)}
.mv-modal h3{margin:0 0 8px;font-size:15px;font-weight:700}
.mv-modal p{margin:0 0 16px;font-size:13px;line-height:1.6;color:var(--ink-mid,#555);
  white-space:pre-wrap;word-break:break-word}
.mv-modal-row{display:flex;gap:8px;justify-content:flex-end}
.mv-modal button{padding:6px 14px;font:inherit;font-size:13px;border-radius:6px;cursor:pointer;
  border:1px solid var(--line,#d8d8d4);background:var(--paper,#fafafa);color:inherit}
.mv-modal button.primary{background:var(--accent,#3067d6);border-color:transparent;color:#fff}
.mv-modal button:focus-visible{outline:2px solid var(--accent,#3067d6);outline-offset:2px}
`;

let cssInjected = false;

function ensureCss() {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement('style');
  style.textContent = MODAL_CSS;
  document.head.appendChild(style);
}

/** 버튼 라벨 배열을 주면 눌린 인덱스를 돌려준다. cancelIndex 는 Esc 로 나갈 때 값. */
function modal({ title, detail, buttons, cancelIndex }) {
  ensureCss();
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'mv-modal-back';

    const box = document.createElement('div');
    box.className = 'mv-modal';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');

    const h = document.createElement('h3');
    h.textContent = title;
    const p = document.createElement('p');
    p.textContent = detail || '';
    const row = document.createElement('div');
    row.className = 'mv-modal-row';

    const done = (index) => {
      document.removeEventListener('keydown', onKey, true);
      back.remove();
      resolve(index);
    };

    const onKey = (e) => {
      if (e.key === 'Escape' && cancelIndex != null) {
        e.preventDefault();
        e.stopPropagation();
        done(cancelIndex);
      }
    };

    buttons.forEach((label, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      if (i === 0) b.className = 'primary';
      b.addEventListener('click', () => done(i));
      row.appendChild(b);
    });

    box.append(h, p, row);
    back.appendChild(box);
    document.body.appendChild(back);
    document.addEventListener('keydown', onKey, true);
    row.querySelector('button')?.focus();
  });
}

/* ------------------------------------------------------------ 이벤트 */

const on = (name, cb) => { listen(name, (e) => cb(e.payload)); };

/** 렌더러가 동기적으로 읽어 가므로 마지막 상태를 들고 있는다. */
let lastUpdateState = { status: 'idle' };
listen('update:state', (e) => { lastUpdateState = e.payload; });

// 메인이 알려주는 오류는 모달로 보여 준다 (Electron 의 showErrorBox 자리)
listen('app:error', (e) => {
  const { title, detail } = e.payload || {};
  modal({ title: title || '오류', detail, buttons: ['확인'], cancelIndex: 0 });
});

// 도움말 → MD Viewer 정보
listen('help:about', async () => {
  const version = await invoke('app_version');
  modal({
    title: `MD Viewer ${version}`,
    detail: 'Tauri · WebView2 기반',
    buttons: ['확인'],
    cancelIndex: 0,
  });
});

/* 파일 드롭.
   WebView2 는 OS 파일 드래그를 DOM 이벤트로 주지 않는다. Tauri 가 주는
   경로를 받아 처리하고, renderer.js 의 시각 효과 클래스만 맞춰 준다. */
getCurrentWebview().onDragDropEvent((event) => {
  const { type } = event.payload;
  if (type === 'over') {
    document.body.classList.add('dragging');
    return;
  }
  if (type === 'leave') {
    document.body.classList.remove('dragging');
    return;
  }
  if (type === 'drop') {
    document.body.classList.remove('dragging');
    const paths = (event.payload.paths || [])
      .filter((p) => MD_EXTS.has(extname(p).toLowerCase()));
    if (paths.length) invoke('open_path', { paths });
  }
});

/* --------------------------------------------------------------- API */

window.api = {
  render,
  ready: () => invoke('ready'),

  /* ---- 파일 ---- */
  pickFiles: () => invoke('pick_files'),
  openPath: (p) => invoke('open_path', { paths: p }),
  readFile: (p) => invoke('read_file', { path: p }),
  saveFile: (path, text) => invoke('save_file', { path: path || null, text }),
  saveFileAs: (text, name) => invoke('save_file_as', { text, name: name || null }),
  setWatchList: (paths) => invoke('set_watch_list', { paths: (paths || []).filter(Boolean) }),

  /** 0 저장 / 1 저장 안 함 / 2 취소 — Electron 판과 같은 계약 */
  confirmClose: (name) => modal({
    title: `${name} 의 변경 내용을 저장할까요?`,
    detail: '저장하지 않으면 지금까지의 수정이 사라집니다.',
    buttons: ['저장', '저장 안 함', '취소'],
    cancelIndex: 2,
  }),

  /* ---- 상태 보고 ---- */
  reportState: (state) => invoke('report_state', {
    name: state?.name ?? '제목 없음',
    dirty: !!state?.dirty,
    dirtyCount: state?.dirtyCount ?? 0,
  }),
  forceQuit: () => invoke('force_quit'),

  /* ---- 바깥으로 ---- */
  openExternal: (url) => invoke('open_external', { url }),
  openLocal: (p) => invoke('open_local', { path: p }),
  reveal: (p) => invoke('reveal', { path: p || '' }),

  /* ---- 업데이트 ---- */
  appVersion: () => invoke('app_version'),
  updateState: async () => lastUpdateState,
  checkUpdate: () => invoke('check_update'),
  downloadUpdate: () => invoke('download_update'),
  installUpdate: () => invoke('install_update'),
  onUpdateState: (cb) => on('update:state', cb),

  /* ---- 설정 ---- */
  getSettings: () => invoke('get_settings'),
  setSettings: (patch) => invoke('set_settings', { patch }),
  systemPrefersDark: async () =>
    window.matchMedia('(prefers-color-scheme: dark)').matches,

  /* ---- 드롭된 File 객체의 경로 ----
     WebView2 는 경로를 주지 않는다. 위의 onDragDropEvent 가 이미 처리하므로
     여기서는 null 을 돌려 renderer.js 의 중복 처리를 막는다. */
  pathForFile: () => null,

  /* ---- 메인에서 오는 신호 ---- */
  onOpen: (cb) => on('tab:open', cb),
  onFileChanged: (cb) => on('file:changed', cb),
  onSaveAllQuit: (cb) => on('app:save-all-quit', () => cb()),
  onZoom: (cb) => on('view:zoom', cb),
  onToggleToc: (cb) => on('view:toggle-toc', () => cb()),
  onToggleTheme: (cb) => on('view:toggle-theme', () => cb()),
  onMode: (cb) => on('view:mode', cb),

  onCommand: (cb) => {
    const names = [
      'doc:new', 'doc:save', 'doc:save-as', 'doc:save-all', 'doc:reload', 'doc:reveal',
      'tab:close', 'tab:close-others', 'tab:next', 'tab:prev',
      'edit:undo', 'edit:redo', 'edit:find', 'edit:bold', 'edit:italic', 'edit:link',
      'help:syntax', 'help:keys',
    ];
    for (const name of names) listen(name, () => cb(name));
  },
};
