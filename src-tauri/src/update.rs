//! 자동 업데이트. Electron 판의 electron-updater 자리를 대신한다.
//!
//! 흐름과 렌더러로 보내는 상태 문자열은 그대로 유지했다.
//!   idle → checking → available / none / error
//!   available → downloading(percent) → ready → (설치)
//! 설치 파일을 자동으로 받지 않고 먼저 물어보는 것도 그대로다.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct Hub {
    state: Mutex<Option<Value>>,
    found: Mutex<Option<Update>>,
    bytes: Mutex<Option<Vec<u8>>>,
    manual: AtomicBool,
}

impl Hub {
    pub fn snapshot(&self) -> Value {
        self.state
            .lock()
            .ok()
            .and_then(|s| s.clone())
            .unwrap_or_else(|| json!({ "status": "idle" }))
    }
}

fn send(app: &AppHandle, payload: Value) {
    if let Some(hub) = app.try_state::<Hub>() {
        if let Ok(mut slot) = hub.state.lock() {
            *slot = Some(payload.clone());
        }
    }
    let _ = app.emit("update:state", payload);
}

/// 사용자에게 보여줄 만한 한 줄로 줄인다. 자세한 내용은 콘솔에만 남긴다.
fn error_text(err: &dyn std::fmt::Display) -> String {
    let raw = err.to_string();
    eprintln!("[update] {raw}");
    let lower = raw.to_lowercase();
    if lower.contains("404") || lower.contains("could not fetch") || lower.contains("not found") {
        return "아직 올라온 릴리스가 없습니다.".into();
    }
    if lower.contains("dns")
        || lower.contains("connect")
        || lower.contains("timed out")
        || lower.contains("network")
    {
        return "네트워크에 연결할 수 없습니다.".into();
    }
    if lower.contains("rate limit") {
        return "GitHub 요청 한도에 걸렸습니다. 잠시 뒤 다시 시도하세요.".into();
    }
    raw.lines().next().unwrap_or("").chars().take(140).collect()
}

/// 개발 빌드에서는 확인하지 않는다. 설정이 비어 있으면 그것도 알려 준다.
fn blocked(app: &AppHandle) -> Option<&'static str> {
    if cfg!(debug_assertions) && std::env::var("MD_VIEWER_DEV_UPDATE").as_deref() != Ok("1") {
        return Some("dev");
    }
    match app.updater_builder().build() {
        Ok(_) => None,
        Err(_) => Some("unconfigured"),
    }
}

pub fn check(app: &AppHandle, manual: bool) {
    if let Some(reason) = blocked(app) {
        if manual {
            send(app, json!({ "status": reason, "manual": true }));
        }
        return;
    }

    let hub = app.state::<Hub>();
    hub.manual.store(manual, Ordering::Relaxed);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        send(&app, json!({ "status": "checking", "manual": manual }));

        let updater = match app.updater() {
            Ok(u) => u,
            Err(err) => {
                send(&app, json!({ "status": "error", "message": error_text(&err), "manual": manual }));
                return;
            }
        };

        match updater.check().await {
            Ok(Some(found)) => {
                let payload = json!({
                    "status": "available",
                    "version": found.version,
                    "notes": found.body.clone().unwrap_or_default(),
                    "manual": manual,
                });
                *app.state::<Hub>().found.lock().unwrap() = Some(found);
                send(&app, payload);
            }
            Ok(None) => send(
                &app,
                json!({
                    "status": "none",
                    "version": app.package_info().version.to_string(),
                    "manual": manual,
                }),
            ),
            Err(err) => send(
                &app,
                json!({ "status": "error", "message": error_text(&err), "manual": manual }),
            ),
        }
    });
}

pub fn download(app: &AppHandle) {
    let found = app.state::<Hub>().found.lock().unwrap().clone();
    let Some(update) = found else {
        send(app, json!({ "status": "error", "message": "받을 업데이트가 없습니다.", "manual": true }));
        return;
    };

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut got: usize = 0;
        let progress = {
            let app = app.clone();
            move |chunk: usize, total: Option<u64>| {
                got += chunk;
                let total = total.unwrap_or(0);
                let percent = if total > 0 { got as f64 * 100.0 / total as f64 } else { 0.0 };
                send(
                    &app,
                    json!({
                        "status": "downloading",
                        "percent": percent.round() as u64,
                        "transferred": got,
                        "total": total,
                    }),
                );
            }
        };

        match update.download(progress, || {}).await {
            Ok(bytes) => {
                let version = update.version.clone();
                *app.state::<Hub>().bytes.lock().unwrap() = Some(bytes);
                send(&app, json!({ "status": "ready", "version": version }));
            }
            Err(err) => send(
                &app,
                json!({ "status": "error", "message": error_text(&err), "manual": true }),
            ),
        }
    });
}

/// 여기까지 왔으면 렌더러가 저장을 마친 상태다.
pub fn install(app: &AppHandle) {
    let hub = app.state::<Hub>();
    let update = hub.found.lock().unwrap().clone();
    let bytes = hub.bytes.lock().unwrap().take();

    let (Some(update), Some(bytes)) = (update, bytes) else {
        send(app, json!({ "status": "error", "message": "설치할 파일이 준비되지 않았습니다.", "manual": true }));
        return;
    };

    if let Err(err) = update.install(bytes) {
        send(app, json!({ "status": "error", "message": error_text(&err), "manual": true }));
    }
}
