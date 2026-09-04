//! 문서 읽기·쓰기와 마크다운 파일 판별.

use serde::Serialize;
use std::path::{Path, PathBuf};

pub const MD_EXTS: [&str; 6] = ["md", "markdown", "mdown", "mkd", "mdtext", "mdtxt"];

/// 렌더러가 탭을 만들 때 쓰는 문서 한 벌.
#[derive(Clone, Serialize)]
pub struct Doc {
    pub path: String,
    pub dir: String,
    pub name: String,
    pub text: String,
}

pub fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| MD_EXTS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

pub fn read_doc(path: &Path) -> std::io::Result<Doc> {
    let text = read_text(path)?;
    Ok(Doc {
        path: path.display().to_string(),
        dir: path
            .parent()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        text,
    })
}

/// UTF-8 로 읽되, BOM 은 떼고 깨진 바이트는 대체 문자로 바꾼다.
/// (Electron 판의 `fs.readFileSync(p, 'utf8')` 과 같은 관용도)
fn read_text(path: &Path) -> std::io::Result<String> {
    let bytes = std::fs::read(path)?;
    let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
    Ok(String::from_utf8_lossy(body).into_owned())
}

/// 실행 인자에서 실제로 존재하는 마크다운 파일만 뽑는다.
/// 개발:  cargo tauri dev -- a.md    배포:  "MD Viewer.exe" a.md b.md
pub fn files_from_args<I: IntoIterator<Item = String>>(args: I) -> Vec<PathBuf> {
    args.into_iter()
        .skip(1)
        .filter(|a| !a.is_empty() && !a.starts_with('-') && a != ".")
        .map(PathBuf::from)
        .filter_map(|p| std::fs::canonicalize(&p).ok().map(strip_unc))
        .filter(|p| is_markdown(p) && p.is_file())
        .collect()
}

/// `canonicalize` 가 붙이는 `\\?\` 접두어를 뗀다.
/// 이 경로는 그대로 렌더러와 WebView 로 넘어가므로 평범한 형태여야 한다.
/// (`\\?\UNC\server\share` 형태는 `\\server\share` 로 되돌린다)
pub fn strip_unc(p: PathBuf) -> PathBuf {
    let s = p.display().to_string();
    if let Some(rest) = s.strip_prefix("\\\\?\\UNC\\") {
        return PathBuf::from(format!("\\\\{rest}"));
    }
    match s.strip_prefix("\\\\?\\") {
        Some(rest) => PathBuf::from(rest),
        None => p,
    }
}
