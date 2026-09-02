// 용량 측정용 최소 Tauri 앱.
// 실제 이식에서는 여기에 main.js 의 창·탭·파일 입출력·메뉴·감시가 들어간다.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("Tauri 앱 실행 실패");
}
