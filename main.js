'use strict';

const { app, BrowserWindow, Menu, dialog, shell, ipcMain, nativeTheme } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('node:path');
const fs = require('node:fs');

const MD_EXTS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mdtext', '.mdtxt']);

let win = null;
let rendererReady = false;
let pending = [];        // 렌더러가 준비되기 전에 들어온 파일들
let forceClose = false;

/* 렌더러가 알려주는 현재 문서 상태 (제목 표시줄과 종료 확인에 쓴다) */
let docState = { name: '제목 없음', dirty: false, dirtyCount: 0 };

/* 열려 있는 탭들의 파일 감시 */
const watchers = new Map();   // 경로 -> FSWatcher
const muted = new Map();      // 경로 -> 이 시각 전까지는 변경 무시 (우리가 저장한 것)

/* ------------------------------------------------------------------ *
 * 작은 설정 저장소 (테마 / 글자 크기 / 화면 구성)
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
 * 개발:  electron .  a.md b.md   배포:  MDViewer.exe a.md b.md
 * ------------------------------------------------------------------ */
function extractFileArgs(argv) {
  const out = [];
  for (const raw of argv.slice(1)) {
    if (!raw || raw.startsWith('-') || raw === '.') continue;
    if (!MD_EXTS.has(path.extname(raw).toLowerCase())) continue;
    const abs = path.resolve(raw);
    if (fs.existsSync(abs)) out.push(abs);
  }
  return out;
}

/* 이미 실행 중이면 그 창에서 연다 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const files = extractFileArgs(argv);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    if (files.length) openFiles(files);
  });
}

/* ------------------------------------------------------------------ *
 * 파일 읽기 / 열기 / 감시
 * ------------------------------------------------------------------ */
function readDoc(filePath) {
  return {
    path: filePath,
    dir: path.dirname(filePath),
    name: path.basename(filePath),
    text: fs.readFileSync(filePath, 'utf8'),
  };
}

/** 파일들을 렌더러로 보낸다. 탭을 만들지 기존 탭을 살릴지는 렌더러가 판단한다. */
function openFiles(paths) {
  const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  if (!list.length) return;
  if (!win) { pending.push(...list); createWindow(); return; }
  if (!rendererReady) { pending.push(...list); return; }

  for (const p of list) {
    try {
      win.webContents.send('tab:open', readDoc(p));
      app.addRecentDocument(p);
    } catch (err) {
      dialog.showErrorBox('파일을 열 수 없습니다', `${p}\n\n${err.message}`);
    }
  }
}

/** 렌더러가 준 목록대로 감시 대상을 맞춘다. */
function setWatchList(paths) {
  const want = new Set((paths || []).filter(Boolean));

  for (const [p, w] of watchers) {
    if (want.has(p)) continue;
    try { w.close(); } catch {}
    watchers.delete(p);
  }

  for (const p of want) {
    if (watchers.has(p)) continue;
    try {
      let timer = null;
      const w = fs.watch(p, () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (Date.now() < (muted.get(p) || 0)) return;   // 방금 우리가 저장한 것
          if (!fs.existsSync(p)) return;
          try { win?.webContents.send('file:changed', readDoc(p)); } catch {}
        }, 120);
      });
      watchers.set(p, w);
    } catch { /* 감시 실패는 보기 기능에 영향이 없다 */ }
  }
}

function closeAllWatchers() {
  for (const w of watchers.values()) { try { w.close(); } catch {} }
  watchers.clear();
}

/* ------------------------------------------------------------------ *
 * 저장
 * ------------------------------------------------------------------ */
function writeDoc(target, text) {
  muted.set(target, Date.now() + 900);
  fs.writeFileSync(target, text, 'utf8');
  app.addRecentDocument(target);
  return {
    ok: true,
    path: target,
    dir: path.dirname(target),
    name: path.basename(target),
  };
}

async function askSavePath(defaultName) {
  const options = {
    title: '다른 이름으로 저장',
    defaultPath: defaultName || '제목 없음.md',
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
  };
  const res = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
  return res.canceled ? null : res.filePath;
}

async function saveAs(text, defaultName) {
  const target = await askSavePath(defaultName);
  if (!target) return { ok: false, canceled: true };
  try {
    return writeDoc(target, text);
  } catch (err) {
    dialog.showErrorBox('저장하지 못했습니다', `${target}\n\n${err.message}`);
    return { ok: false };
  }
}


/* ------------------------------------------------------------------ *
 * 자동 업데이트
 *
 * GitHub 릴리스에 올라간 latest.yml 을 보고 새 버전을 판단한다.
 * 설치 파일이 100MB 가 넘으므로 자동으로 받지 않고 먼저 물어본다.
 * (두 번째 업데이트부터는 blockmap 덕분에 바뀐 부분만 받는다.)
 * ------------------------------------------------------------------ */

const UPDATE_INTERVAL = 4 * 60 * 60 * 1000;   // 4시간마다 조용히 확인

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

/* 개발 중에 업데이트 흐름을 확인하고 싶을 때:
   프로젝트 루트에 dev-app-update.yml 을 두고
   MD_VIEWER_DEV_UPDATE=1 로 실행하면 설치본이 아니어도 확인한다. */
const devUpdate = process.env.MD_VIEWER_DEV_UPDATE === '1';
if (devUpdate) autoUpdater.forceDevUpdateConfig = true;

let updateState = { status: 'idle' };
let manualCheck = false;

function sendUpdate(payload) {
  updateState = payload;
  if (win && !win.isDestroyed()) win.webContents.send('update:state', payload);
}

/** 개발 중이거나 저장소를 아직 지정하지 않았으면 확인하지 않는다. */
/* 설치본의 package.json 에는 build 필드가 없다. electron-builder 가 패키징할 때
   지우기 때문이다. 그래서 발행 대상은 electron-builder 가 resources 에 넣어주는
   app-update.yml 에서 읽어야 한다. package.json 을 보면 설치본에서는 publish 가
   언제나 undefined 라, 제대로 설정된 빌드에서도 확인 자체가 막힌다. */
function updateReason() {
  if (devUpdate) return null;
  if (!app.isPackaged) return 'dev';
  try {
    const config = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
    const owner = /^owner:\s*(.+)$/m.exec(config);
    if (!owner || owner[1].trim() === 'OWNER') return 'unconfigured';
  } catch {
    return 'unconfigured';   // 발행 설정 없이 빌드된 경우
  }
  return null;
}

/** 사용자에게 보여줄 만한 한 줄로 줄인다. 스택 트레이스는 콘솔에만 남긴다. */
function updateErrorText(err) {
  const raw = String(err?.message || err || '');
  console.error('[update]', raw);
  if (/404|Cannot find channel|No published versions/i.test(raw)) {
    return '아직 올라온 릴리스가 없습니다.';
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|net::/i.test(raw)) {
    return '네트워크에 연결할 수 없습니다.';
  }
  if (/rate limit/i.test(raw)) return 'GitHub 요청 한도에 걸렸습니다. 잠시 뒤 다시 시도하세요.';
  return raw.split('\n')[0].slice(0, 140);
}

function checkForUpdates({ manual = false } = {}) {
  const blocked = updateReason();
  if (blocked) {
    if (manual) sendUpdate({ status: blocked, manual: true });
    return;
  }
  manualCheck = manual;
  autoUpdater.checkForUpdates().catch((err) => {
    sendUpdate({ status: 'error', message: updateErrorText(err), manual });
  });
}

autoUpdater.on('checking-for-update', () => sendUpdate({ status: 'checking', manual: manualCheck }));

autoUpdater.on('update-available', (info) => sendUpdate({
  status: 'available',
  version: info.version,
  notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '',
  manual: manualCheck,
}));

autoUpdater.on('update-not-available', () => sendUpdate({
  status: 'none',
  version: app.getVersion(),
  manual: manualCheck,
}));

autoUpdater.on('download-progress', (p) => sendUpdate({
  status: 'downloading',
  percent: Math.round(p.percent),
  transferred: p.transferred,
  total: p.total,
}));

autoUpdater.on('update-downloaded', (info) => sendUpdate({ status: 'ready', version: info.version }));

autoUpdater.on('error', (err) => sendUpdate({
  status: 'error',
  message: updateErrorText(err),
  manual: manualCheck,
}));

/* ------------------------------------------------------------------ *
 * 창
 * ------------------------------------------------------------------ */
function refreshTitle() {
  if (win) win.setTitle(`${docState.dirty ? '\u25CF ' : ''}${docState.name} — MD Viewer`);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 520,
    minHeight: 380,
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

  // 저장하지 않은 탭이 있으면 물어본다
  win.on('close', (e) => {
    if (forceClose || docState.dirtyCount === 0) return;
    e.preventDefault();

    const n = docState.dirtyCount;
    dialog.showMessageBox(win, {
      type: 'warning',
      noLink: true,
      title: '저장하지 않은 변경 내용',
      message: n === 1
        ? '저장하지 않은 문서가 1개 있습니다.'
        : `저장하지 않은 문서가 ${n}개 있습니다.`,
      detail: '저장하지 않으면 변경 내용이 사라집니다.',
      buttons: ['모두 저장', '저장 안 함', '취소'],
      defaultId: 0,
      cancelId: 2,
    }).then(({ response }) => {
      if (response === 2) return;
      if (response === 1) { forceClose = true; win.close(); return; }
      win.webContents.send('app:save-all-quit');
    });
  });

  win.on('closed', () => {
    closeAllWatchers();
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
        { label: '새 문서', accelerator: 'CmdOrCtrl+N', click: () => send('doc:new') },
        { label: '열기…', accelerator: 'CmdOrCtrl+O', click: showOpenDialog },
        { type: 'separator' },
        { label: '저장', accelerator: 'CmdOrCtrl+S', click: () => send('doc:save') },
        { label: '다른 이름으로 저장…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('doc:save-as') },
        { label: '모두 저장', accelerator: 'CmdOrCtrl+Alt+S', click: () => send('doc:save-all') },
        { type: 'separator' },
        { label: '디스크에서 다시 불러오기', accelerator: 'CmdOrCtrl+R', click: () => send('doc:reload') },
        { label: '탐색기에서 보기', click: () => send('doc:reveal') },
        { type: 'separator' },
        { label: '탭 닫기', accelerator: 'CmdOrCtrl+W', click: () => send('tab:close') },
        { label: '다른 탭 모두 닫기', click: () => send('tab:close-others') },
        { type: 'separator' },
        { label: '끝내기', role: 'quit' },
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
        { label: '다음 탭', accelerator: 'Control+Tab', click: () => send('tab:next') },
        { label: '이전 탭', accelerator: 'Control+Shift+Tab', click: () => send('tab:prev') },
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
        { label: '마크다운 문법', accelerator: 'F1', click: () => send('help:syntax') },
        { label: '단축키 목록', click: () => send('help:keys') },
        { type: 'separator' },
        { label: '업데이트 확인', click: () => checkForUpdates({ manual: true }) },
        { type: 'separator' },
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

async function showOpenDialog() {
  const options = {
    title: '마크다운 파일 열기',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd'] },
      { name: '모든 파일', extensions: ['*'] },
    ],
  };
  const res = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  if (!res.canceled && res.filePaths.length) openFiles(res.filePaths);
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */
ipcMain.on('app:ready', () => {
  rendererReady = true;
  const first = pending.length ? pending : extractFileArgs(process.argv);
  pending = [];
  if (first.length) openFiles(first);
});

ipcMain.handle('files:pick', showOpenDialog);
ipcMain.handle('file:open', (_e, p) => openFiles(p));
ipcMain.handle('file:read', (_e, p) => {
  try { return readDoc(p); } catch { return null; }
});

ipcMain.handle('file:save', (_e, { path: target, text }) => {
  if (!target) return saveAs(text);
  try {
    return writeDoc(target, text);
  } catch (err) {
    dialog.showErrorBox('저장하지 못했습니다', `${target}\n\n${err.message}`);
    return { ok: false };
  }
});
ipcMain.handle('file:save-as', (_e, { text, name }) => saveAs(text, name));

ipcMain.handle('watch:set', (_e, paths) => setWatchList(paths));

ipcMain.on('doc:state', (_e, state) => {
  docState = { name: '제목 없음', dirty: false, dirtyCount: 0, ...state };
  refreshTitle();
});

/** 탭을 닫을 때 저장 여부를 묻는다. 0 저장 / 1 저장 안 함 / 2 취소 */
ipcMain.handle('dialog:confirm-close', async (_e, name) => {
  if (!win) return 1;
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    noLink: true,
    title: '저장하지 않은 변경 내용',
    message: `${name} 의 변경 내용을 저장할까요?`,
    detail: '저장하지 않으면 지금까지의 수정이 사라집니다.',
    buttons: ['저장', '저장 안 함', '취소'],
    defaultId: 0,
    cancelId: 2,
  });
  return response;
});

ipcMain.handle('shell:external', (_e, url) => {
  if (/^(https?|mailto):/i.test(url)) return shell.openExternal(url);
});
ipcMain.handle('shell:open-path', (_e, p) => shell.openPath(p));
ipcMain.handle('shell:reveal', (_e, p) => p && shell.showItemInFolder(p));
ipcMain.handle('theme:system-dark', () => nativeTheme.shouldUseDarkColors);
ipcMain.handle('settings:get', () => readSettings());
ipcMain.handle('settings:set', (_e, patch) => writeSettings(patch));
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('update:state', () => updateState);
ipcMain.handle('update:check', () => checkForUpdates({ manual: true }));
ipcMain.handle('update:download', () => {
  autoUpdater.downloadUpdate().catch((err) => {
    sendUpdate({ status: 'error', message: updateErrorText(err), manual: true });
  });
});
ipcMain.handle('update:install', () => {
  // 여기까지 왔으면 렌더러가 저장을 마친 상태다. 종료 확인을 건너뛴다.
  forceClose = true;
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
});

ipcMain.handle('app:force-quit', () => {
  forceClose = true;
  docState.dirtyCount = 0;
  if (win) win.close();
});

/* ------------------------------------------------------------------ *
 * 앱 수명주기
 * ------------------------------------------------------------------ */
// macOS: Finder 에서 열기
app.on('open-file', (e, p) => {
  e.preventDefault();
  openFiles([p]);
});

app.whenReady().then(() => {
  buildMenu();
  createWindow();

  // 창이 뜨고 조금 지난 뒤에 조용히 확인한다
  setTimeout(() => checkForUpdates(), 8000);
  setInterval(() => checkForUpdates(), UPDATE_INTERVAL);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
