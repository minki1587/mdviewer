// 창을 띄우는 것이 목적이므로 콘솔 창은 띄우지 않는다.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod docs;
mod menu;
mod settings;
mod update;
mod watcher;

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};

use docs::Doc;

/* ------------------------------------------------------------------ *
 * 앱 상태
 * ------------------------------------------------------------------ */

/// 렌더러가 알려주는 현재 문서 상태 (제목 표시줄과 종료 확인에 쓴다)
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct DocState {
    name: String,
    dirty: bool,
    dirty_count: u32,
}

impl Default for DocState {
    fn default() -> Self {
        Self {
            name: "제목 없음".into(),
            dirty: false,
            dirty_count: 0,
        }
    }
}

#[derive(Default)]
struct AppState {
    doc: Mutex<DocState>,
    /// 렌더러가 준비되기 전에 들어온 파일들
    pending: Mutex<Vec<PathBuf>>,
    ready: AtomicBool,
    force_close: AtomicBool,
    watcher: Mutex<watcher::Watcher>,
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

/* ------------------------------------------------------------------ *
 * 파일 열기
 * ------------------------------------------------------------------ */

/// 파일들을 렌더러로 보낸다. 탭을 만들지 기존 탭을 살릴지는 렌더러가 판단한다.
fn open_files(app: &AppHandle, paths: Vec<PathBuf>) {
    if paths.is_empty() {
        return;
    }
    let state = app.state::<AppState>();

    if !state.ready.load(Ordering::Relaxed) {
        state.pending.lock().unwrap().extend(paths);
        return;
    }

    for path in paths {
        match docs::read_doc(&path) {
            Ok(doc) => {
                let _ = app.emit("tab:open", doc);
            }
            Err(err) => {
                let app = app.clone();
                let text = format!("{}\n\n{err}", path.display());
                tauri::async_runtime::spawn_blocking(move || {
                    app.dialog()
                        .message(text)
                        .title("파일을 열 수 없습니다")
                        .kind(MessageDialogKind::Error)
                        .blocking_show();
                });
            }
        }
    }
}

fn show_open_dialog(app: &AppHandle) {
    let app = app.clone();
    let mut builder = app
        .dialog()
        .file()
        .set_title("마크다운 파일 열기")
        .add_filter("Markdown", &["md", "markdown", "mdown", "mkd"])
        .add_filter("모든 파일", &["*"]);
    if let Some(win) = main_window(&app) {
        builder = builder.set_parent(&win);
    }
    builder.pick_files(move |picked| {
        let paths: Vec<PathBuf> = picked
            .unwrap_or_default()
            .into_iter()
            .filter_map(|f| f.into_path().ok())
            .map(docs::strip_unc)
            .collect();
        open_files(&app, paths);
    });
}

/* ------------------------------------------------------------------ *
 * 저장
 * ------------------------------------------------------------------ */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveResult {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    canceled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

impl SaveResult {
    fn failed() -> Self {
        Self {
            ok: false,
            canceled: None,
            path: None,
            dir: None,
            name: None,
        }
    }
    fn canceled() -> Self {
        Self {
            ok: false,
            canceled: Some(true),
            path: None,
            dir: None,
            name: None,
        }
    }
}

fn write_doc(app: &AppHandle, target: &PathBuf, text: &str) -> SaveResult {
    // 우리가 쓴 것이므로 감시기가 "바깥에서 바뀜" 으로 보지 않게 한다
    app.state::<AppState>().watcher.lock().unwrap().mute(target);

    if let Err(err) = std::fs::write(target, text) {
        let handle = app.clone();
        let message = format!("{}\n\n{err}", target.display());
        tauri::async_runtime::spawn_blocking(move || {
            handle
                .dialog()
                .message(message)
                .title("저장하지 못했습니다")
                .kind(MessageDialogKind::Error)
                .blocking_show();
        });
        return SaveResult::failed();
    }
    // 쓰기가 끝난 뒤의 시각을 기준선으로 다시 잡는다
    app.state::<AppState>().watcher.lock().unwrap().mute(target);

    SaveResult {
        ok: true,
        canceled: None,
        path: Some(target.display().to_string()),
        dir: target.parent().map(|p| p.display().to_string()),
        name: target
            .file_name()
            .map(|n| n.to_string_lossy().into_owned()),
    }
}

fn ask_save_path(app: &AppHandle, default_name: Option<String>) -> Option<PathBuf> {
    let (tx, rx) = std::sync::mpsc::channel();
    let mut builder = app
        .dialog()
        .file()
        .set_title("다른 이름으로 저장")
        .set_file_name(default_name.unwrap_or_else(|| "제목 없음.md".into()))
        .add_filter("Markdown", &["md", "markdown"]);
    if let Some(win) = main_window(app) {
        builder = builder.set_parent(&win);
    }
    builder.save_file(move |picked| {
        let _ = tx.send(picked.and_then(|f| f.into_path().ok()).map(docs::strip_unc));
    });
    rx.recv().ok().flatten()
}

/* ------------------------------------------------------------------ *
 * 커맨드 — 렌더러의 window.api 한 항목에 하나씩 대응한다
 * ------------------------------------------------------------------ */

#[tauri::command]
fn app_ready(app: AppHandle) {
    let queued: Vec<PathBuf> = {
        let state = app.state::<AppState>();
        state.ready.store(true, Ordering::Relaxed);
        let mut queued: Vec<PathBuf> = state.pending.lock().unwrap().drain(..).collect();
        if queued.is_empty() {
            queued = docs::files_from_args(std::env::args());
        }
        queued
    };
    open_files(&app, queued);
}

#[tauri::command]
fn pick_files(app: AppHandle) {
    show_open_dialog(&app);
}

#[tauri::command]
fn open_paths(app: AppHandle, paths: Vec<String>) {
    open_files(&app, paths.into_iter().map(PathBuf::from).collect());
}

#[tauri::command]
fn read_doc(path: String) -> Option<Doc> {
    docs::read_doc(&PathBuf::from(path)).ok()
}

#[tauri::command]
async fn save_file(app: AppHandle, path: Option<String>, text: String) -> SaveResult {
    match path.filter(|p| !p.is_empty()) {
        Some(p) => write_doc(&app, &PathBuf::from(p), &text),
        None => match ask_save_path(&app, None) {
            Some(target) => write_doc(&app, &target, &text),
            None => SaveResult::canceled(),
        },
    }
}

#[tauri::command]
async fn save_file_as(app: AppHandle, text: String, name: Option<String>) -> SaveResult {
    match ask_save_path(&app, name) {
        Some(target) => write_doc(&app, &target, &text),
        None => SaveResult::canceled(),
    }
}

#[tauri::command]
fn set_watch_list(app: AppHandle, paths: Vec<String>) {
    let list = paths.into_iter().map(PathBuf::from).collect();
    app.state::<AppState>().watcher.lock().unwrap().set_list(list);
}

/// 탭을 닫을 때 저장 여부를 묻는다. 0 저장 / 1 저장 안 함 / 2 취소
#[tauri::command]
async fn confirm_close(app: AppHandle, name: String) -> i32 {
    ask_three(
        &app,
        "저장하지 않은 변경 내용",
        &format!("{name} 의 변경 내용을 저장할까요?\n\n저장하지 않으면 지금까지의 수정이 사라집니다."),
        ("저장", "저장 안 함", "취소"),
    )
}

#[tauri::command]
fn set_doc_state(app: AppHandle, state: DocState) {
    let title = format!(
        "{}{} — MD Viewer",
        if state.dirty { "\u{25CF} " } else { "" },
        state.name
    );
    *app.state::<AppState>().doc.lock().unwrap() = state;
    if let Some(win) = main_window(&app) {
        let _ = win.set_title(&title);
    }
}

#[tauri::command]
fn force_quit(app: AppHandle) {
    {
        let state = app.state::<AppState>();
        state.force_close.store(true, Ordering::Relaxed);
        state.doc.lock().unwrap().dirty_count = 0;
    }
    if let Some(win) = main_window(&app) {
        let _ = win.close();
    }
}

#[tauri::command]
fn open_external(url: String) {
    let ok = url.starts_with("http://") || url.starts_with("https://") || url.starts_with("mailto:");
    if ok {
        let _ = tauri_plugin_opener::open_url(url, None::<&str>);
    }
}

#[tauri::command]
fn open_local(path: String) {
    let _ = tauri_plugin_opener::open_path(path, None::<&str>);
}

#[tauri::command]
fn reveal(path: String) {
    let _ = tauri_plugin_opener::reveal_item_in_dir(PathBuf::from(path));
}

#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
fn system_prefers_dark(app: AppHandle) -> bool {
    main_window(&app)
        .and_then(|w| w.theme().ok())
        .map(|t| t == tauri::Theme::Dark)
        .unwrap_or(false)
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Value {
    settings::read(&app)
}

#[tauri::command]
fn set_settings(app: AppHandle, patch: Value) {
    settings::merge(&app, patch);
}

#[tauri::command]
fn update_state(app: AppHandle) -> Value {
    app.state::<update::Hub>().snapshot()
}

#[tauri::command]
fn update_check(app: AppHandle) {
    update::check(&app, true);
}

#[tauri::command]
fn update_download(app: AppHandle) {
    update::download(&app);
}

#[tauri::command]
fn update_install(app: AppHandle) {
    app.state::<AppState>()
        .force_close
        .store(true, Ordering::Relaxed);
    update::install(&app);
}

/* ------------------------------------------------------------------ *
 * 3버튼 대화상자
 *
 * 네이티브 대화상자는 창을 만든 스레드에서 열려야 한다. 콜백형으로 띄우고
 * 채널로 결과만 받아 오면, 커맨드 스레드는 잠시 기다리기만 하면 된다.
 * ------------------------------------------------------------------ */
fn ask_three(app: &AppHandle, title: &str, message: &str, labels: (&str, &str, &str)) -> i32 {
    let (yes, no, cancel) = labels;
    let (tx, rx) = std::sync::mpsc::channel();

    let mut builder = app
        .dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::YesNoCancelCustom(
            yes.into(),
            no.into(),
            cancel.into(),
        ));
    if let Some(win) = main_window(app) {
        builder = builder.parent(&win);
    }

    let yes_label = yes.to_string();
    let no_label = no.to_string();
    builder.show_with_result(move |result| {
        let code = match result {
            MessageDialogResult::Yes | MessageDialogResult::Ok => 0,
            MessageDialogResult::No => 1,
            MessageDialogResult::Custom(ref s) if *s == yes_label => 0,
            MessageDialogResult::Custom(ref s) if *s == no_label => 1,
            _ => 2,
        };
        let _ = tx.send(code);
    });

    rx.recv().unwrap_or(2)
}

/* ------------------------------------------------------------------ *
 * 메뉴 처리
 * ------------------------------------------------------------------ */
fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "file:open" => show_open_dialog(app),
        "update:check" => update::check(app, true),
        "mode:toggle" => {
            let _ = app.emit("view:mode", "toggle");
        }
        "mode:split" => {
            let _ = app.emit("view:mode", "split");
        }
        "zoom:in" => {
            let _ = app.emit("view:zoom", 1i32);
        }
        "zoom:out" => {
            let _ = app.emit("view:zoom", -1i32);
        }
        "zoom:reset" => {
            let _ = app.emit("view:zoom", 0i32);
        }
        "view:devtools" => {
            if let Some(win) = main_window(app) {
                if win.is_devtools_open() {
                    win.close_devtools();
                } else {
                    win.open_devtools();
                }
            }
        }
        "help:about" => {
            let version = app.package_info().version.to_string();
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                app.dialog()
                    .message(format!(
                        "MD Viewer {version}\n\nTauri {} · WebView2",
                        tauri::VERSION
                    ))
                    .title("MD Viewer")
                    .kind(MessageDialogKind::Info)
                    .blocking_show();
            });
        }
        // 나머지는 이름 그대로 렌더러가 알아듣는다
        other => {
            let _ = app.emit(other, ());
        }
    }
}

/* ------------------------------------------------------------------ *
 * 창 닫기 — 저장하지 않은 탭이 있으면 물어본다
 * ------------------------------------------------------------------ */
fn on_close_requested(app: &AppHandle, api: &tauri::CloseRequestApi) {
    let n = {
        let state = app.state::<AppState>();
        if state.force_close.load(Ordering::Relaxed) {
            return;
        }
        let n = state.doc.lock().unwrap().dirty_count;
        if n == 0 {
            return;
        }
        n
    };

    api.prevent_close();

    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let message = if n == 1 {
            "저장하지 않은 문서가 1개 있습니다.\n\n저장하지 않으면 변경 내용이 사라집니다.".to_string()
        } else {
            format!("저장하지 않은 문서가 {n}개 있습니다.\n\n저장하지 않으면 변경 내용이 사라집니다.")
        };
        match ask_three(
            &app,
            "저장하지 않은 변경 내용",
            &message,
            ("모두 저장", "저장 안 함", "취소"),
        ) {
            0 => {
                let _ = app.emit("app:save-all-quit", ());
            }
            1 => {
                app.state::<AppState>()
                    .force_close
                    .store(true, Ordering::Relaxed);
                if let Some(win) = main_window(&app) {
                    let _ = win.close();
                }
            }
            _ => {}
        }
    });
}

/* ------------------------------------------------------------------ *
 * 시작
 * ------------------------------------------------------------------ */
fn main() {
    tauri::Builder::default()
        // 이미 실행 중이면 그 창에서 연다. 반드시 가장 먼저 등록해야 한다.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(win) = main_window(app) {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
            open_files(app, docs::files_from_args(argv));
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::default())
        .manage(update::Hub::default())
        .invoke_handler(tauri::generate_handler![
            app_ready,
            pick_files,
            open_paths,
            read_doc,
            save_file,
            save_file_as,
            set_watch_list,
            confirm_close,
            set_doc_state,
            force_quit,
            open_external,
            open_local,
            reveal,
            app_version,
            system_prefers_dark,
            get_settings,
            set_settings,
            update_state,
            update_check,
            update_download,
            update_install,
        ])
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .on_window_event(|win, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                on_close_requested(win.app_handle(), api);
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            app.set_menu(menu::build(&handle)?)?;

            if let Some(win) = main_window(&handle) {
                let _ = win.show();
            }

            // 열린 탭의 파일이 바깥에서 바뀌었는지 지켜본다
            {
                let handle = handle.clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(watcher::POLL);
                    let hits = {
                        let state = handle.state::<AppState>();
                        let mut w = state.watcher.lock().unwrap();
                        w.changed()
                    };
                    for path in hits {
                        if let Ok(doc) = docs::read_doc(&path) {
                            let _ = handle.emit("file:changed", doc);
                        }
                    }
                });
            }

            // 창이 뜨고 조금 지난 뒤에 조용히 확인하고, 그 뒤 4시간마다 다시 본다
            {
                let handle = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(8));
                    update::check(&handle, false);
                    loop {
                        std::thread::sleep(Duration::from_secs(4 * 60 * 60));
                        update::check(&handle, false);
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("MD Viewer 실행 실패");
}
