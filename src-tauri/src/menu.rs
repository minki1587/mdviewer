//! 상단 메뉴. Electron 판의 Menu.buildFromTemplate 을 그대로 옮겼다.
//!
//! 눌린 항목은 id 그대로 메뉴 이벤트가 되고, main.rs 가 대부분을
//! 같은 이름의 이벤트로 렌더러에 넘긴다. 렌더러의 onCommand 는
//! Electron 때와 똑같은 문자열을 받는다.

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, SubmenuBuilder},
    AppHandle, Runtime,
};

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let item = |id: &str, label: &str, accel: Option<&str>| {
        MenuItem::with_id(app, id, label, true, accel)
    };

    let file = SubmenuBuilder::new(app, "파일(&F)")
        .item(&item("doc:new", "새 문서", Some("CmdOrCtrl+N"))?)
        .item(&item("file:open", "열기…", Some("CmdOrCtrl+O"))?)
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
        .item(&item("mode:toggle", "읽기 / 편집 전환", Some("CmdOrCtrl+E"))?)
        .item(&item("mode:split", "나란히 보기", Some("CmdOrCtrl+Shift+E"))?)
        .separator()
        .item(&item("tab:next", "다음 탭", Some("Control+Tab"))?)
        .item(&item("tab:prev", "이전 탭", Some("Control+Shift+Tab"))?)
        .separator()
        .item(&item("zoom:in", "글자 크게", Some("CmdOrCtrl+="))?)
        .item(&item("zoom:out", "글자 작게", Some("CmdOrCtrl+-"))?)
        .item(&item("zoom:reset", "기본 크기", Some("CmdOrCtrl+0"))?)
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

    Menu::with_items(app, &[&file, &edit, &view, &help])
}
