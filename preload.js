'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { marked } = require('marked');
const hljs = require('highlight.js');

// DOMPurify 는 버전에 따라 인스턴스 또는 팩토리로 export 된다.
const _dp = require('dompurify');
const DOMPurify = typeof _dp.sanitize === 'function' ? _dp : _dp(window);

marked.setOptions({ gfm: true, breaks: false, pedantic: false });

const MD_EXTS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mdtext', '.mdtxt']);
const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

/** 상대 경로를 문서 폴더 기준 file:// URL 로 바꾼다. */
function resolveLocal(ref, baseDir) {
  if (!ref || !baseDir || ABSOLUTE.test(ref)) return null;
  let decoded = ref;
  try { decoded = decodeURIComponent(ref); } catch {}
  const [clean] = decoded.split('#');
  return path.resolve(baseDir, clean);
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

/**
 * 마크다운 -> { html, toc }
 * baseDir 기준으로 상대 이미지/링크를 해석한다.
 */
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

  // 3) 이미지 경로 해석
  root.querySelectorAll('img').forEach((img) => {
    const abs = resolveLocal(img.getAttribute('src'), baseDir);
    if (abs) img.setAttribute('src', pathToFileURL(abs).href);
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
    if (MD_EXTS.has(path.extname(abs).toLowerCase())) a.dataset.mdPath = abs;
    else a.dataset.filePath = abs;
  });

  // 5) 체크박스는 읽기 전용
  root.querySelectorAll('input[type="checkbox"]').forEach((el) => {
    el.setAttribute('disabled', '');
  });

  return { html: root.innerHTML, toc };
}

contextBridge.exposeInMainWorld('api', {
  render,
  ready: () => ipcRenderer.send('app:ready'),
  onFile: (cb) => ipcRenderer.on('file:loaded', (_e, payload) => cb(payload)),
  onZoom: (cb) => ipcRenderer.on('view:zoom', (_e, delta) => cb(delta)),
  onToggleToc: (cb) => ipcRenderer.on('view:toggle-toc', () => cb()),
  onToggleTheme: (cb) => ipcRenderer.on('view:toggle-theme', () => cb()),
  onNewFile: (cb) => ipcRenderer.on('file:new', () => cb()),
  onMode: (cb) => ipcRenderer.on('view:mode', (_e, mode) => cb(mode)),
  onSave: (cb) => ipcRenderer.on('doc:save', () => cb()),
  onSaveAs: (cb) => ipcRenderer.on('doc:save-as', () => cb()),
  onSaveThen: (cb) => ipcRenderer.on('doc:save-then', (_e, pending) => cb(pending || {})),
  onChangedOutside: (cb) => ipcRenderer.on('file:changed-outside', () => cb()),
  onEditCommand: (cb) => {
    for (const name of ['undo', 'redo', 'find', 'bold', 'italic', 'link']) {
      ipcRenderer.on(`edit:${name}`, () => cb(name));
    }
  },
  openDialog: () => ipcRenderer.invoke('dialog:open'),
  newFile: () => ipcRenderer.invoke('file:new'),
  saveFile: (path, text) => ipcRenderer.invoke('file:save', { path, text }),
  saveFileAs: (text) => ipcRenderer.invoke('file:save-as', { text }),
  setDirty: (dirty) => ipcRenderer.send('doc:dirty', dirty),
  forceQuit: () => ipcRenderer.invoke('app:force-quit'),
  openPath: (p) => ipcRenderer.invoke('file:open', p),
  openExternal: (url) => ipcRenderer.invoke('shell:external', url),
  openLocal: (p) => ipcRenderer.invoke('shell:open-path', p),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  systemPrefersDark: () => ipcRenderer.invoke('theme:system-dark'),
  // 드래그&드롭된 File 객체에서 실제 경로 얻기
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return file.path || null; }
  },
});
