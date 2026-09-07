// MD Viewer — Tauri 백엔드
//
// Electron 판의 main.js 를 옮긴 것이다. 렌더러(renderer/renderer.js)는 한 줄도
// 고치지 않았고, window.api 의 함수 이름과 반환 모양을 그대로 맞춘다.
// 반환값은 serde_json::json! 으로 만들어 JS 쪽 기대 형태와 1:1 로 대응시킨다.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use serde_json::{json, Value};
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_dialog::DialogExt;

const MD_EXTS: [&str; 6] = ["md", "markdown", "mdown", "mkd", "mdtext", "mdtxt"];

/* ------------------------------------------------------------------ *
 * 상태
 * ------------------------------------------------------------------ */

#[derive(Default)]
struct AppState {
    /// 감시 대상 경로 -> 마지막으로 본 수정 시각
    watch: Mutex<HashMap<String, Option<SystemTime>>>,
    /// 우리가 방금 저장한 파일은 이 시각까지 변경을 무시한다
    muted: Mutex<HashMap<String, SystemTime>>,
    /// 렌더러가 준비되기 전에 들어온 파일들
    pending: Mutex<Vec<String>>,
    /// 저장하지 않은 탭 수 (창 닫기 확인에 쓴다)
    dirty_count: Mutex<u32>,
    /// 렌더러가 저장을 마쳐 이제 정말 닫아도 될 때
    force_close: Mutex<bool>,
}

/* ------------------------------------------------------------------ *
 * 파일 유틸
 * ------------------------------------------------------------------ */

fn is_md(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| MD_EXTS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// 렌더러가 기대하는 { path, dir, name, text } 를 만든다.
fn read_doc(path: &str) -> Result<Value, String> {
    let p = PathBuf::from(path);
    let text = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    Ok(json!({
        "path": p.to_string_lossy(),
        "dir": p.parent().map(|d| d.to_string_lossy().to_string()).unwrap_or_default(),
        "name": p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        "text": text,
    }))
}

/// 실행 인자에서 마크다운 파일만 골라낸다.
fn files_from_args(args: &[String]) -> Vec<String> {
    args.iter()
        .skip(1)
        .filter(|a| !a.is_empty() && !a.starts_with('-') && *a != ".")
        .filter_map(|a| {
            let p = PathBuf::from(a);
            if is_md(&p) && p.exists() {
                Some(p.canonicalize().unwrap_or(p).to_string_lossy().to_string())
            } else {
                None
            }
        })
        .collect()
}

/// 파일들을 렌더러로 보낸다. 탭을 새로 만들지는 렌더러가 판단한다.
fn emit_open(app: &AppHandle, paths: Vec<String>) {
    for p in paths {
        match read_doc(&p) {
            Ok(doc) => {
                let _ = app.emit("tab:open", doc);
            }
            Err(err) => {
                let _ = app.emit("app:error", json!({
                    "title": "파일을 열 수 없습니다",
                    "detail": format!("{}\n\n{}", p, err),
                }));
            }
        }
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

/* ------------------------------------------------------------------ *
 * 명령 — 파일
 * ------------------------------------------------------------------ */

/// 창은 visible:false 로 만들어 두고 여기서 보여 준다.
/// Electron 판의 ready-to-show 와 같은 자리다. 내용이 그려지기 전에
/// 빈 창이 번쩍이는 것을 막는다.
fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

#[tauri::command]
fn ready(app: AppHandle, state: State<AppState>) {
    show_main_window(&app);

    let queued: Vec<String> = {
        let mut pending = state.pending.lock().unwrap();
        std::mem::take(&mut *pending)
    };
    let first = if queued.is_empty() {
        files_from_args(&std::env::args().collect::<Vec<_>>())
    } else {
        queued
    };
    if !first.is_empty() {
        emit_open(&app, first);
    }
}

#[tauri::command]
fn read_file(path: String) -> Option<Value> {
    read_doc(&path).ok()
}

#[tauri::command]
fn open_path(app: AppHandle, paths: Value) {
    let list: Vec<String> = match paths {
        Value::String(s) => vec![s],
        Value::Array(items) => items
            .into_iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect(),
        _ => vec![],
    };
    emit_open(&app, list);
}

#[tauri::command]
async fn pick_files(app: AppHandle) {
    let picked = app
        .dialog()
        .file()
        .set_title("마크다운 파일 열기")
        .add_filter("Markdown", &["md", "markdown", "mdown", "mkd"])
        .add_filter("모든 파일", &["*"])
        .blocking_pick_files();

    if let Some(files) = picked {
        let paths: Vec<String> = files
            .into_iter()
            .filter_map(|f| f.into_path().ok())
            .map(|p| p.to_string_lossy().to_string())
            .collect();
        emit_open(&app, paths);
    }
}

/// 실제로 디스크에 쓴다. 우리가 낸 변경이므로 잠깐 감시를 무시하게 한다.
fn write_doc(state: &State<AppState>, target: &str, text: &str) -> Result<Value, String> {
    state.muted.lock().unwrap().insert(
        target.to_string(),
        SystemTime::now() + Duration::from_millis(900),
    );
    fs::write(target, text).map_err(|e| e.to_string())?;

    let p = PathBuf::from(target);
    Ok(json!({
        "ok": true,
        "path": p.to_string_lossy(),
        "dir": p.parent().map(|d| d.to_string_lossy().to_string()).unwrap_or_default(),
        "name": p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
    }))
}

fn ask_save_path(app: &AppHandle, default_name: Option<String>) -> Option<PathBuf> {
    app.dialog()
        .file()
        .set_title("다른 이름으로 저장")
        .set_file_name(default_name.unwrap_or_else(|| "제목 없음.md".into()))
        .add_filter("Markdown", &["md", "markdown"])
        .blocking_save_file()
        .and_then(|p| p.into_path().ok())
}

#[tauri::command]
async fn save_file(
    app: AppHandle,
    state: State<'_, AppState>,
    path: Option<String>,
    text: String,
) -> Result<Value, String> {
    let target = match path {
        Some(p) if !p.is_empty() => p,
        _ => match ask_save_path(&app, None) {
            Some(p) => p.to_string_lossy().to_string(),
            None => return Ok(json!({ "ok": false, "canceled": true })),
        },
    };

    match write_doc(&state, &target, &text) {
        Ok(v) => Ok(v),
        Err(err) => {
            let _ = app.emit("app:error", json!({
                "title": "저장하지 못했습니다",
                "detail": format!("{}\n\n{}", target, err),
            }));
            Ok(json!({ "ok": false }))
        }
    }
}

#[tauri::command]
async fn save_file_as(
    app: AppHandle,
    state: State<'_, AppState>,
    text: String,
    name: Option<String>,
) -> Result<Value, String> {
    let target = match ask_save_path(&app, name) {
        Some(p) => p.to_string_lossy().to_string(),
        None => return Ok(json!({ "ok": false, "canceled": true })),
    };

    match write_doc(&state, &target, &text) {
        Ok(v) => Ok(v),
        Err(err) => {
            let _ = app.emit("app:error", json!({
                "title": "저장하지 못했습니다",
                "detail": format!("{}\n\n{}", target, err),
            }));
            Ok(json!({ "ok": false }))
        }
    }
}

/* ------------------------------------------------------------------ *
 * 명령 — 파일 감시
 *
 * notify 크레이트 대신 짧은 주기의 mtime 확인을 쓴다. 열린 탭 몇 개가
 * 대상이라 비용이 없고, 플랫폼별 감시 동작 차이에 휘둘리지 않는다.
 * ------------------------------------------------------------------ */

#[tauri::command]
fn set_watch_list(state: State<AppState>, paths: Vec<String>) {
    let mut watch = state.watch.lock().unwrap();
    watch.retain(|p, _| paths.contains(p));
    for p in paths {
        if p.is_empty() {
            continue;
        }
        watch.entry(p.clone()).or_insert_with(|| mtime_of(&p));
    }
}

fn mtime_of(path: &str) -> Option<SystemTime> {
    fs::metadata(path).ok().and_then(|m| m.modified().ok())
}

fn spawn_watcher(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(700));

        let state = app.state::<AppState>();
        let now = SystemTime::now();

        // 확인할 목록만 잠깐 복사해서 잠금을 오래 쥐지 않는다
        let snapshot: Vec<(String, Option<SystemTime>)> = {
            let watch = state.watch.lock().unwrap();
            watch.iter().map(|(k, v)| (k.clone(), *v)).collect()
        };

        for (path, seen) in snapshot {
            let current = mtime_of(&path);
            if current == seen {
                continue;
            }

            {
                let mut watch = state.watch.lock().unwrap();
                if let Some(slot) = watch.get_mut(&path) {
                    *slot = current;
                } else {
                    continue; // 그사이 목록에서 빠졌다
                }
            }

            // 방금 우리가 저장한 변경이면 알리지 않는다
            let is_muted = state
                .muted
                .lock()
                .unwrap()
                .get(&path)
                .map(|until| now < *until)
                .unwrap_or(false);
            if is_muted || current.is_none() {
                continue;
            }

            if let Ok(doc) = read_doc(&path) {
                let _ = app.emit("file:changed", doc);
            }
        }
    });
}

/* ------------------------------------------------------------------ *
 * 명령 — 상태 / 창
 * ------------------------------------------------------------------ */

#[tauri::command]
fn report_state(app: AppHandle, state: State<AppState>, name: String, dirty: bool, dirty_count: u32) {
    *state.dirty_count.lock().unwrap() = dirty_count;
    if let Some(win) = app.get_webview_window("main") {
        let mark = if dirty { "\u{25CF} " } else { "" };
        let _ = win.set_title(&format!("{}{} — MD Viewer", mark, name));
    }
}

#[tauri::command]
fn force_quit(app: AppHandle, state: State<AppState>) {
    *state.force_close.lock().unwrap() = true;
    *state.dirty_count.lock().unwrap() = 0;
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.close();
    }
}

/* ------------------------------------------------------------------ *
 * 명령 — 바깥으로
 * ------------------------------------------------------------------ */

#[tauri::command]
fn open_external(app: AppHandle, url: String) {
    if url.starts_with("http://") || url.starts_with("https://") || url.starts_with("mailto:") {
        use tauri_plugin_opener::OpenerExt;
        let _ = app.opener().open_url(url, None::<&str>);
    }
}

#[tauri::command]
fn open_local(app: AppHandle, path: String) {
    use tauri_plugin_opener::OpenerExt;
    let _ = app.opener().open_path(path, None::<&str>);
}

#[tauri::command]
fn reveal(app: AppHandle, path: String) {
    if path.is_empty() {
        return;
    }
    use tauri_plugin_opener::OpenerExt;
    let _ = app.opener().reveal_item_in_dir(path);
}

/* ------------------------------------------------------------------ *
 * 명령 — 설정 / 정보
 * ------------------------------------------------------------------ */

#[tauri::command]
fn get_settings(app: AppHandle) -> Value {
    settings_path(&app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_else(|| json!({}))
}

#[tauri::command]
fn set_settings(app: AppHandle, patch: Value) {
    let mut current = get_settings(app.clone());
    if let (Some(base), Some(add)) = (current.as_object_mut(), patch.as_object()) {
        for (k, v) in add {
            base.insert(k.clone(), v.clone());
        }
    }
    if let Ok(path) = settings_path(&app) {
        let _ = fs::write(path, serde_json::to_string_pretty(&current).unwrap_or_default());
    }
}

#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/* ------------------------------------------------------------------ *
 * 메뉴
 *
 * 메뉴 항목 id 를 그대로 렌더러 이벤트 이름으로 쓴다. Electron 판에서
 * send('doc:new') 하던 것과 같은 문자열이라 렌더러가 그대로 알아듣는다.
 * ------------------------------------------------------------------ */

fn build_menu(app: &AppHandle) -> tauri::Result<()> {
    let item = |id: &str, label: &str, accel: Option<&str>| {
        let mut b = MenuItemBuilder::with_id(id, label);
        if let Some(a) = accel {
            b = b.accelerator(a);
        }
        b.build(app)
    };

    let file = SubmenuBuilder::new(app, "파일(&F)")
        .item(&item("doc:new", "새 문서", Some("CmdOrCtrl+N"))?)
        .item(&item("files:pick", "열기…", Some("CmdOrCtrl+O"))?)
        .separator()
        .item(&item("doc:save", "저장", Some("CmdOrCtrl+S"))?)
        .item(&item("doc:save-as", "다른 이름으로 저장…", Some("CmdOrCtrl+Shift+S"))?)
        .item(&item("doc:save-all", "모두 저장", Some("CmdOrCtrl+Alt+S"))?)
        .separator()
        .item(&item("doc:reload", "디스크에서 다시 불러오기", Some("CmdOrCtrl+R"))?)
        .item(&item("doc:reveal", "탐색기에서 보기", None)?)
        .separator()
        .item(&item("tab:close", "탭 닫기", Some("CmdOrCtrl+W"))?)
        .item(&item("tab:close-others", "다른 탭 모두 닫기", None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, Some("끝내기"))?)
        .build()?;

    let edit = SubmenuBuilder::new(app, "편집(&E)")
        .item(&item("edit:undo", "되돌리기", Some("CmdOrCtrl+Z"))?)
        .item(&item("edit:redo", "다시 실행", Some("CmdOrCtrl+Shift+Z"))?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, Some("잘라내기"))?)
        .item(&PredefinedMenuItem::copy(app, Some("복사"))?)
        .item(&PredefinedMenuItem::paste(app, Some("붙여넣기"))?)
        .item(&PredefinedMenuItem::select_all(app, Some("모두 선택"))?)
        .separator()
        .item(&item("edit:find", "찾기 / 바꾸기", Some("CmdOrCtrl+F"))?)
        .separator()
        .item(&item("edit:bold", "굵게", Some("CmdOrCtrl+B"))?)
        .item(&item("edit:italic", "기울임", Some("CmdOrCtrl+I"))?)
        .item(&item("edit:link", "링크", Some("CmdOrCtrl+K"))?)
        .build()?;

    let view = SubmenuBuilder::new(app, "보기(&V)")
        .item(&item("view:mode:toggle", "읽기 / 편집 전환", Some("CmdOrCtrl+E"))?)
        .item(&item("view:mode:split", "나란히 보기", Some("CmdOrCtrl+Shift+E"))?)
        .separator()
        .item(&item("tab:next", "다음 탭", Some("Control+Tab"))?)
        .item(&item("tab:prev", "이전 탭", Some("Control+Shift+Tab"))?)
        .separator()
        .item(&item("view:zoom:in", "글자 크게", Some("CmdOrCtrl+="))?)
        .item(&item("view:zoom:out", "글자 작게", Some("CmdOrCtrl+-"))?)
        .item(&item("view:zoom:reset", "기본 크기", Some("CmdOrCtrl+0"))?)
        .separator()
        .item(&item("view:toggle-toc", "목차 열고 닫기", Some("CmdOrCtrl+\\"))?)
        .item(&item("view:toggle-theme", "어두운 화면 전환", Some("CmdOrCtrl+D"))?)
        .separator()
        .item(&PredefinedMenuItem::fullscreen(app, Some("전체 화면"))?)
        .item(&item("view:devtools", "개발자 도구", Some("F12"))?)
        .build()?;

    let help = SubmenuBuilder::new(app, "도움말(&H)")
        .item(&item("help:syntax", "마크다운 문법", Some("F1"))?)
        .item(&item("help:keys", "단축키 목록", None)?)
        .separator()
        .item(&item("update:check", "업데이트 확인", None)?)
        .separator()
        .item(&item("help:about", "MD Viewer 정보", None)?)
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&file, &edit, &view, &help])
        .build()?;

    app.set_menu(menu)?;
    Ok(())
}

/// 메뉴 id 를 렌더러가 기다리는 이벤트로 바꿔 보낸다.
fn dispatch_menu(app: &AppHandle, id: &str) {
    match id {
        "files:pick" => {
            let handle = app.clone();
            tauri::async_runtime::spawn(async move { pick_files(handle).await });
        }
        "update:check" => check_update_inner(app.clone(), true),
        "view:devtools" => {
            if let Some(win) = app.get_webview_window("main") {
                if win.is_devtools_open() {
                    win.close_devtools();
                } else {
                    win.open_devtools();
                }
            }
        }
        "view:mode:toggle" => {
            let _ = app.emit("view:mode", "toggle");
        }
        "view:mode:split" => {
            let _ = app.emit("view:mode", "split");
        }
        "view:zoom:in" => {
            let _ = app.emit("view:zoom", 1i32);
        }
        "view:zoom:out" => {
            let _ = app.emit("view:zoom", -1i32);
        }
        "view:zoom:reset" => {
            let _ = app.emit("view:zoom", 0i32);
        }
        other => {
            let _ = app.emit(other, ());
        }
    }
}

/* ------------------------------------------------------------------ *
 * 자동 업데이트
 *
 * Electron 판과 같은 상태 모양({ status, version, percent, ... })을 보내
 * 렌더러의 알림 카드가 그대로 동작하게 한다.
 * ------------------------------------------------------------------ */

fn send_update(app: &AppHandle, payload: Value) {
    let _ = app.emit("update:state", payload);
}

fn check_update_inner(app: AppHandle, manual: bool) {
    use tauri_plugin_updater::UpdaterExt;

    tauri::async_runtime::spawn(async move {
        if manual {
            send_update(&app, json!({ "status": "checking", "manual": true }));
        }

        let updater = match app.updater() {
            Ok(u) => u,
            Err(err) => {
                if manual {
                    send_update(&app, json!({
                        "status": "unconfigured",
                        "manual": true,
                        "message": err.to_string(),
                    }));
                }
                return;
            }
        };

        match updater.check().await {
            Ok(Some(update)) => {
                send_update(&app, json!({
                    "status": "available",
                    "version": update.version,
                    "notes": update.body.clone().unwrap_or_default(),
                    "manual": manual,
                }));
                *app.state::<PendingUpdate>().0.lock().unwrap() = Some(update);
            }
            Ok(None) => {
                if manual {
                    send_update(&app, json!({
                        "status": "none",
                        "version": app.package_info().version.to_string(),
                        "manual": true,
                    }));
                }
            }
            Err(err) => {
                if manual {
                    send_update(&app, json!({
                        "status": "error",
                        "message": update_error_text(&err.to_string()),
                        "manual": true,
                    }));
                }
            }
        }
    });
}

/// 스택 트레이스를 그대로 카드에 넣지 않고 한 줄로 줄인다.
fn update_error_text(raw: &str) -> String {
    let lower = raw.to_lowercase();
    if lower.contains("404") || lower.contains("no published") {
        return "아직 올라온 릴리스가 없습니다.".into();
    }
    if lower.contains("dns") || lower.contains("connect") || lower.contains("timed out") {
        return "네트워크에 연결할 수 없습니다.".into();
    }
    if lower.contains("rate limit") {
        return "GitHub 요청 한도에 걸렸습니다. 잠시 뒤 다시 시도하세요.".into();
    }
    raw.lines().next().unwrap_or(raw).chars().take(140).collect()
}

/// check 로 받아 둔 업데이트를 install 때까지 들고 있는다.
#[derive(Default)]
struct PendingUpdate(Mutex<Option<tauri_plugin_updater::Update>>);

#[tauri::command]
fn check_update(app: AppHandle) {
    check_update_inner(app, true);
}

#[tauri::command]
fn download_update(app: AppHandle) {
    let update = app.state::<PendingUpdate>().0.lock().unwrap().clone();
    let Some(update) = update else {
        send_update(&app, json!({ "status": "error", "message": "받을 업데이트가 없습니다.", "manual": true }));
        return;
    };

    tauri::async_runtime::spawn(async move {
        let mut downloaded: usize = 0;
        let handle = app.clone();
        let progress = app.clone();

        let result = update
            .download_and_install(
                move |chunk, total| {
                    downloaded += chunk;
                    let total = total.unwrap_or(0) as usize;
                    let percent = if total > 0 { downloaded * 100 / total } else { 0 };
                    send_update(&progress, json!({
                        "status": "downloading",
                        "percent": percent,
                        "transferred": downloaded,
                        "total": total,
                    }));
                },
                move || {
                    send_update(&handle, json!({ "status": "ready" }));
                },
            )
            .await;

        if let Err(err) = result {
            send_update(&app, json!({
                "status": "error",
                "message": update_error_text(&err.to_string()),
                "manual": true,
            }));
        }
    });
}

#[tauri::command]
fn install_update(app: AppHandle, state: State<AppState>) {
    // 여기까지 왔으면 렌더러가 저장을 마친 상태다. 종료 확인을 건너뛴다.
    *state.force_close.lock().unwrap() = true;
    app.restart();
}

/* ------------------------------------------------------------------ *
 * 진입점
 * ------------------------------------------------------------------ */

fn main() {
    let mut builder = tauri::Builder::default();

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
            let files = files_from_args(&argv);
            if !files.is_empty() {
                emit_open(app, files);
            }
        }));
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::default())
        .manage(PendingUpdate::default())
        .invoke_handler(tauri::generate_handler![
            ready,
            read_file,
            open_path,
            pick_files,
            save_file,
            save_file_as,
            set_watch_list,
            report_state,
            force_quit,
            open_external,
            open_local,
            reveal,
            get_settings,
            set_settings,
            app_version,
            check_update,
            download_update,
            install_update,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            build_menu(&handle)?;

            app.on_menu_event(move |app, event| {
                dispatch_menu(app, event.id().as_ref());
            });

            spawn_watcher(handle.clone());

            // 안전장치: 렌더러가 ready 를 못 보내는 상황(스크립트 오류 등)에도
            // 창은 떠야 한다. 보이지 않는 창은 진단할 방법조차 없다.
            let fallback = handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(3));
                show_main_window(&fallback);
            });

            // 창이 뜨고 조금 지난 뒤 조용히 한 번, 이후 4시간마다.
            // tokio 를 직접 의존하지 않으려고 평범한 스레드에서 잰다.
            let quiet = handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(8));
                check_update_inner(quiet.clone(), false);
                loop {
                    std::thread::sleep(Duration::from_secs(4 * 60 * 60));
                    check_update_inner(quiet.clone(), false);
                }
            });

            if let Some(win) = app.get_webview_window("main") {
                let closer = handle.clone();
                win.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        let state = closer.state::<AppState>();
                        let forced = *state.force_close.lock().unwrap();
                        let dirty = *state.dirty_count.lock().unwrap();
                        if forced || dirty == 0 {
                            return;
                        }
                        // 모두 저장 / 저장 안 함 / 취소를 묻는다. 네이티브 대화상자는
                        // 버튼이 두 개까지라 JS 쪽 모달이 띄우고 답을 돌려준다.
                        api.prevent_close();
                        let _ = closer.emit("app:close-requested", dirty);
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("MD Viewer 를 시작하지 못했습니다");
}
