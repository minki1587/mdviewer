//! 작은 설정 저장소 (테마 / 글자 크기 / 화면 구성).
//! Electron 판의 userData/settings.json 과 같은 자리다.

use serde_json::{Map, Value};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};

fn file(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    fs::create_dir_all(&dir).ok()?;
    Some(dir.join("settings.json"))
}

pub fn read(app: &AppHandle) -> Value {
    file(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| Value::Object(Map::new()))
}

/// 넘어온 조각만 덮어쓴다. 저장에 실패해도 앱 동작에는 영향이 없다.
pub fn merge(app: &AppHandle, patch: Value) {
    let mut base = read(app);
    if let (Some(dst), Some(src)) = (base.as_object_mut(), patch.as_object()) {
        for (k, v) in src {
            dst.insert(k.clone(), v.clone());
        }
    }
    if let Some(path) = file(app) {
        let _ = fs::write(path, serde_json::to_string_pretty(&base).unwrap_or_default());
    }
}
