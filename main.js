'use strict';

const { app, BrowserWindow, Menu, dialog, shell, ipcMain, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const MD_EXTS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mdtext', '.mdtxt']);

let win = null;
let currentFile = null;
let watcher = null;
let pendingFile = null;   // 창이 준비되기 전에 들어온 파일
let rendererReady = false;
let isDirty = false;      // 렌더러가 알려주는 저장 여부
let forceClose = false;
let muteWatchUntil = 0;   // 우리가 방금 저장한 변경은 무시

/* ------------------------------------------------------------------ *
 * 작은 설정 저장소 (테마 / 글자 크기 / 목차 고정)
 * ------------------------------------------------------------------ */
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); }
  catch { return {}; }
}
function writeSettings(patch) {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify({ ...readSettings(), ...patch }, null, 2));
  } catch { /* 저장 실패는 무시 */ }
}

/* ------------------------------------------------------------------ *
 * 실행 인자에서 마크다운 파일 경로 뽑기
 * 개발:  electron .  README.md      -> ['electron', '.', 'README.md']
 * 배포:  MDViewer.exe README.md     -> ['MDViewer.exe', 'README.md']
 * ------------------------------------------------------------------ */
function extractFileArg(argv) {
  for (const raw of argv.slice(1)) {
    if (!raw || raw.startsWith('-') || raw === '.') continue;
    if (!MD_EXTS.has(path.extname(raw).toLowerCase())) continue;
    const abs = path.resolve(raw);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 단일 인스턴스: 이미 실행 중이면 기존 창에서 열기
 * ------------------------------------------------------------------ */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const f = extractFileArg(argv);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (f) openFile(f);
    }
  });
}

/* ------------------------------------------------------------------ *
 * 파일 열기 / 감시
 * ------------------------------------------------------------------ */
function sendFile(filePath, { keepScroll = false } = {}) {
  const text = fs.readFileSync(filePath, 'utf8');
  currentFile = filePath;
  isDirty = false;
  if (win) {
    win.setTitle(titleFor());
    win.webContents.send('file:loaded', {
      path: filePath,
      dir: path.dirname(filePath),
      name: path.basename(filePath),
      text,
      keepScroll,
    });
  }
}

async function openFile(filePath) {
  if (!win) { pendingFile = filePath; createWindow(); return; }
  if (!rendererReady) { pendingFile = filePath; return; }
  if (!(await ensureSaved({ open: filePath }))) return;

  try {
    sendFile(filePath);
    watchFile(filePath);
    app.addRecentDocument(filePath);
  } catch (err) {
    dialog.showErrorBox('파일을 열 수 없습니다', `${filePath}\n\n${err.message}`);
  }
}

async function newFile() {
  if (!win) return;
  if (!(await ensureSaved({ fresh: true }))) return;
  if (watcher) { try { watcher.close(); } catch {} watcher = null; }
  currentFile = null;
  isDirty = false;
  win.setTitle(titleFor());
  win.webContents.send('file:new');
}

function watchFile(filePath) {
  if (watcher) { try { watcher.close(); } catch {} watcher = null; }
  let timer = null;
  try {
    watcher = fs.watch(filePath, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (Date.now() < muteWatchUntil) return;
        if (currentFile !== filePath || !fs.existsSync(filePath)) return;
        if (isDirty) {
          // 편집 중인 내용을 덮어쓰지 않는다
          if (win) win.webContents.send('file:changed-outside');
          return;
        }
        try { sendFile(filePath, { keepScroll: true }); } catch {}
      }, 120);
    });
  } catch {
    /* 감시 실패는 조용히 넘어감 — 보기 기능에는 영향 없음 */
  }
}

function titleFor() {
  const name = currentFile ? path.basename(currentFile) : '제목 없음';
  return `${isDirty ? '\u25CF ' : ''}${name} — MD Viewer`;
}

async function askSavePath() {
  const options = {
    title: '다른 이름으로 저장',
    defaultPath: currentFile || '제목 없음.md',
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
  };
  const res = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
  return res.canceled ? null : res.filePath;
}

function writeFile(target, text) {
  muteWatchUntil = Date.now() + 900;
  fs.writeFileSync(target, text, 'utf8');
  currentFile = target;
  isDirty = false;
  watchFile(target);
  app.addRecentDocument(target);
  if (win) win.setTitle(titleFor());
  return {
    ok: true,
    path: target,
    dir: path.dirname(target),
    name: path.basename(target),
  };
}

/**
 * 저장하지 않은 변경이 있으면 먼저 처리한다.
 * 바로 진행해도 되면 true, 사용자가 취소했거나 렌더러의 저장을 기다려야 하면 false.
 * pending 은 저장이 끝난 뒤 렌더러가 이어서 할 일이다. ({ open } | { quit } | { fresh })
 */
async function ensureSaved(pending) {
  if (!isDirty || !win) return true;

  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    noLink: true,
    title: '저장하지 않은 변경 내용',
    message: `${currentFile ? path.basename(currentFile) : '제목 없음'} 의 변경 내용을 저장할까요?`,
    detail: '저장하지 않으면 지금까지의 수정이 사라집니다.',
    buttons: ['저장', '저장 안 함', '취소'],
    defaultId: 0,
    cancelId: 2,
  });

  if (response === 2) return false;            // 취소
  if (response === 1) { isDirty = false; return true; }  // 버리고 진행
  win.webContents.send('doc:save-then', pending);        // 저장 후 렌더러가 다시 요청
  return false;
}

async function saveAs(text) {
  const target = await askSavePath();
  if (!target) return { ok: false, canceled: true };
  try {
    return writeFile(target, text);
  } catch (err) {
    dialog.showErrorBox('저장하지 못했습니다', `${target}\n\n${err.message}`);
    return { ok: false };
  }
}

async function showOpenDialog() {
  const options = {
    title: '마크다운 파일 열기',
    properties: ['openFile'],
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd'] },
      { name: '모든 파일', extensions: ['*'] },
    ],
  };
  const res = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);
  if (!res.canceled && res.filePaths[0]) openFile(res.filePaths[0]);
}

/* ------------------------------------------------------------------ *
 * 창
 * ------------------------------------------------------------------ */
function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 800,
    minWidth: 460,
    minHeight: 340,
    show: false,
    title: 'MD Viewer',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#101215' : '#fbfbf9',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,          // preload 에서 require() 를 쓰기 위해 필요
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  win.on('close', (e) => {
    if (forceClose || !isDirty) return;
    e.preventDefault();
    ensureSaved({ quit: true }).then((clear) => {
      if (clear) { forceClose = true; win.close(); }
    });
  });

  win.on('closed', () => {
    if (watcher) { try { watcher.close(); } catch {} watcher = null; }
    rendererReady = false;
    win = null;
  });

  // 창 안에서 새 창을 띄우려는 시도는 모두 기본 브라우저로
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

/* ------------------------------------------------------------------ *
 * 메뉴
 * ------------------------------------------------------------------ */
function buildMenu() {
  const send = (channel, payload) => win && win.webContents.send(channel, payload);

  const template = [
    {
      label: '파일(&F)',
      submenu: [
        { label: '새 문서', accelerator: 'CmdOrCtrl+N', click: newFile },
        { label: '열기…', accelerator: 'CmdOrCtrl+O', click: showOpenDialog },
        { type: 'separator' },
        { label: '저장', accelerator: 'CmdOrCtrl+S', click: () => send('doc:save') },
        { label: '다른 이름으로 저장…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('doc:save-as') },
        { type: 'separator' },
        {
          label: '디스크에서 다시 불러오기',
          accelerator: 'CmdOrCtrl+R',
          click: async () => {
            if (!currentFile) return;
            if (!(await ensureSaved({ open: currentFile }))) return;
            sendFile(currentFile, { keepScroll: true });
          },
        },
        {
          label: '탐색기에서 보기',
          click: () => currentFile && shell.showItemInFolder(currentFile),
        },
        { type: 'separator' },
        { label: '닫기', role: 'quit' },
      ],
    },
    {
      label: '편집(&E)',
      submenu: [
        { label: '되돌리기', accelerator: 'CmdOrCtrl+Z', click: () => send('edit:undo') },
        { label: '다시 실행', accelerator: 'CmdOrCtrl+Shift+Z', click: () => send('edit:redo') },
        { type: 'separator' },
        { label: '잘라내기', role: 'cut' },
        { label: '복사', role: 'copy' },
        { label: '붙여넣기', role: 'paste' },
        { label: '모두 선택', role: 'selectAll' },
        { type: 'separator' },
        { label: '찾기 / 바꾸기', accelerator: 'CmdOrCtrl+F', click: () => send('edit:find') },
        { type: 'separator' },
        { label: '굵게', accelerator: 'CmdOrCtrl+B', click: () => send('edit:bold') },
        { label: '기울임', accelerator: 'CmdOrCtrl+I', click: () => send('edit:italic') },
        { label: '링크', accelerator: 'CmdOrCtrl+K', click: () => send('edit:link') },
      ],
    },
    {
      label: '보기(&V)',
      submenu: [
        { label: '읽기 / 편집 전환', accelerator: 'CmdOrCtrl+E', click: () => send('view:mode', 'toggle') },
        { label: '나란히 보기', accelerator: 'CmdOrCtrl+Shift+E', click: () => send('view:mode', 'split') },
        { type: 'separator' },
        { label: '글자 크게', accelerator: 'CmdOrCtrl+=', click: () => send('view:zoom', +1) },
        { label: '글자 작게', accelerator: 'CmdOrCtrl+-', click: () => send('view:zoom', -1) },
        { label: '기본 크기', accelerator: 'CmdOrCtrl+0', click: () => send('view:zoom', 0) },
        { type: 'separator' },
        { label: '목차 열고 닫기', accelerator: 'CmdOrCtrl+\\', click: () => send('view:toggle-toc') },
        { label: '어두운 화면 전환', accelerator: 'CmdOrCtrl+D', click: () => send('view:toggle-theme') },
        { type: 'separator' },
        { label: '전체 화면', role: 'togglefullscreen' },
        { label: '개발자 도구', accelerator: 'F12', role: 'toggleDevTools' },
      ],
    },
    {
      label: '도움말(&H)',
      submenu: [
        {
          label: 'MD Viewer 정보',
          click: () => dialog.showMessageBox(win, {
            type: 'info',
            title: 'MD Viewer',
            message: `MD Viewer ${app.getVersion()}`,
            detail: `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
            buttons: ['확인'],
          }),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */
ipcMain.on('app:ready', () => {
  rendererReady = true;
  const first = pendingFile || extractFileArg(process.argv);
  pendingFile = null;
  if (first) openFile(first);
});

ipcMain.handle('dialog:open', showOpenDialog);
ipcMain.handle('file:open', (_e, p) => openFile(p));
ipcMain.handle('file:new', () => newFile());

ipcMain.handle('file:save', (_e, { path: target, text }) => {
  try {
    if (target) return writeFile(target, text);
  } catch (err) {
    dialog.showErrorBox('저장하지 못했습니다', `${target}\n\n${err.message}`);
    return { ok: false };
  }
  return saveAs(text);
});

ipcMain.handle('file:save-as', (_e, { text }) => saveAs(text));

ipcMain.on('doc:dirty', (_e, dirty) => {
  isDirty = Boolean(dirty);
  if (win) win.setTitle(titleFor());
});

ipcMain.handle('app:force-quit', () => {
  forceClose = true;
  isDirty = false;
  if (win) win.close();
});
ipcMain.handle('shell:external', (_e, url) => {
  if (/^(https?|mailto):/i.test(url)) return shell.openExternal(url);
});
ipcMain.handle('shell:open-path', (_e, p) => shell.openPath(p));
ipcMain.handle('theme:system-dark', () => nativeTheme.shouldUseDarkColors);
ipcMain.handle('settings:get', () => readSettings());
ipcMain.handle('settings:set', (_e, patch) => writeSettings(patch));

/* ------------------------------------------------------------------ *
 * 앱 수명주기
 * ------------------------------------------------------------------ */
// macOS: Finder 에서 열기
app.on('open-file', (e, p) => {
  e.preventDefault();
  if (rendererReady) openFile(p);
  else pendingFile = p;
});

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
