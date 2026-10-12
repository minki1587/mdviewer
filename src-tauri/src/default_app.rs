// .md 기본 앱 지정
//
// Windows 10/11 은 프로그램이 기본 앱을 스스로 바꾸지 못하게 막는다. 사용자의
// 선택(UserChoice)에는 해시가 붙어 있어 레지스트리를 직접 고치면 Windows 가
// 무시하고 초기화한다. 그래서 여기서 하는 일은 두 가지뿐이다.
//
//   1. 고를 수 있게 등록한다 — 우리 ProgID, '연결 프로그램' 목록(OpenWithProgids),
//      설정 → 기본 앱에 이름이 뜨게 하는 Capabilities / RegisteredApplications.
//   2. Windows 가 직접 띄우는 '연결 프로그램' 창을 연다. 사용자가 거기서
//      MD Viewer 를 고르면 Windows 가 UserChoice 를 제대로 써 준다.
//
// ProgID 는 설치 프로그램이 tauri.conf.json 의 fileAssociations[].name 으로
// 만드는 것과 같아야 한다. 예전 이름 "Markdown Document" 는 Notion 같은 다른
// 앱도 쓰는 이름이라, 그 앱이 설치·업데이트될 때 열기 명령을 덮어써 .md 가
// 그 앱으로 열렸다.

use serde_json::{json, Value};

pub const PROG_ID: &str = "MDViewer.Markdown";
const APP_NAME: &str = "MD Viewer";
const APP_DESC: &str = "마크다운 뷰어 겸 편집기";
const TYPE_DESC: &str = "마크다운 문서";
const CAPS_KEY: &str = r"Software\MD Viewer\Capabilities";
/// 설치 프로그램이 연결하는 확장자와 같다 (tauri.conf.json).
const EXTS: [&str; 4] = ["md", "markdown", "mdown", "mkd"];

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};
    use std::ptr::{null, null_mut};

    use windows_sys::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_NONE, REG_SZ, RRF_RT_REG_SZ,
    };
    use windows_sys::Win32::UI::Shell::{
        AssocQueryStringW, SHChangeNotify, SHOpenWithDialog, ASSOCSTR_EXECUTABLE,
        OAIF_FORCE_REGISTRATION, OAIF_REGISTER_EXT, OPENASINFO, SHCNE_ASSOCCHANGED, SHCNF_IDLIST,
    };

    /// 사용자가 창을 닫았을 때 SHOpenWithDialog 가 돌려주는 값
    /// (HRESULT_FROM_WIN32(ERROR_CANCELLED)).
    const HR_CANCELLED: u32 = 0x8007_04C7;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn wide_path(p: &Path) -> Vec<u16> {
        p.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
    }

    /// 이름 없는 값(기본값)이면 name 에 None.
    fn name_ptr(name: &Option<Vec<u16>>) -> *const u16 {
        name.as_ref().map_or(null(), |n| n.as_ptr())
    }

    /// HKCU 아래 key 의 문자열 값을 쓴다. 키가 없으면 만든다.
    pub fn set_str(key: &str, name: Option<&str>, value: &str) -> bool {
        let k = wide(key);
        let n = name.map(wide);
        let v = wide(value);
        let rc = unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                k.as_ptr(),
                name_ptr(&n),
                REG_SZ,
                v.as_ptr() as *const c_void,
                (v.len() * 2) as u32,
            )
        };
        rc == 0
    }

    /// 내용 없는 표식 값. OpenWithProgids 가 이 모양이다.
    pub fn set_marker(key: &str, name: &str) -> bool {
        let k = wide(key);
        let n = Some(wide(name));
        let rc = unsafe {
            RegSetKeyValueW(HKEY_CURRENT_USER, k.as_ptr(), name_ptr(&n), REG_NONE, null(), 0)
        };
        rc == 0
    }

    pub fn get_str(key: &str, name: Option<&str>) -> Option<String> {
        let k = wide(key);
        let n = name.map(wide);
        let mut buf = vec![0u16; 2048];
        let mut size = (buf.len() * 2) as u32;
        let rc = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                k.as_ptr(),
                name_ptr(&n),
                RRF_RT_REG_SZ,
                null_mut(),
                buf.as_mut_ptr() as *mut c_void,
                &mut size,
            )
        };
        if rc != 0 {
            return None;
        }
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..end]))
    }

    /// 탐색기에게 연결 정보가 바뀌었다고 알려 아이콘과 목록을 새로 읽게 한다.
    pub fn notify_changed() {
        unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED as _, SHCNF_IDLIST as _, null(), null()) };
    }

    /// 지금 `.ext` 를 더블클릭하면 실행될 프로그램. UserChoice 까지 반영된 값이다.
    pub fn handler_of(ext: &str) -> Option<PathBuf> {
        let assoc = wide(&format!(".{ext}"));
        let mut buf = vec![0u16; 2048];
        let mut len = buf.len() as u32;
        let hr = unsafe {
            AssocQueryStringW(
                0,
                ASSOCSTR_EXECUTABLE,
                assoc.as_ptr(),
                null(),
                buf.as_mut_ptr(),
                &mut len,
            )
        };
        if hr != 0 {
            return None;
        }
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(PathBuf::from(String::from_utf16_lossy(&buf[..end])))
    }

    pub enum Picked {
        Done,
        Canceled,
        Failed(String),
    }

    /// Windows 의 '연결 프로그램' 창을 띄운다. 사용자가 고르거나 닫을 때까지
    /// 돌아오지 않으므로 메인 스레드가 아닌 곳에서 불러야 한다.
    ///
    /// FORCE_REGISTRATION 은 '항상 이 앱 사용' 을 켠 채로 고정한다 — 이 창을
    /// 여는 목적이 그것이다. OAIF_EXEC 는 주지 않아 고른 뒤 파일을 실제로
    /// 열지는 않는다. 그래서 빈 견본 파일을 넘겨도 된다.
    pub fn open_with_dialog(sample: &Path, parent: isize) -> Picked {
        let file = wide_path(sample);
        let info = OPENASINFO {
            pcszFile: file.as_ptr(),
            pcszClass: null(),
            oaifInFlags: OAIF_FORCE_REGISTRATION | OAIF_REGISTER_EXT,
        };
        let hr = unsafe {
            // 셸 대화상자는 COM 을 쓴다. 이 스레드에서 처음이면 여기서 켠다.
            let com = CoInitializeEx(null(), COINIT_APARTMENTTHREADED as _);
            let hr = SHOpenWithDialog(parent as _, &info);
            if com >= 0 {
                CoUninitialize();
            }
            hr
        };
        match hr as u32 {
            0 => Picked::Done,
            HR_CANCELLED => Picked::Canceled,
            other => Picked::Failed(format!("0x{other:08X}")),
        }
    }
}

/// 두 경로가 같은 실행 파일인지. 대소문자와 8.3 짧은 이름 차이를 흡수한다.
#[cfg(windows)]
fn same_exe(a: &std::path::Path, b: &std::path::Path) -> bool {
    let norm = |p: &std::path::Path| {
        std::fs::canonicalize(p)
            .unwrap_or_else(|_| p.to_path_buf())
            .to_string_lossy()
            .to_lowercase()
    };
    norm(a) == norm(b)
}

#[cfg(windows)]
fn open_command(exe: &std::path::Path) -> String {
    format!("\"{}\" \"%1\"", exe.display())
}

/// 우리를 '고를 수 있는 앱' 으로 등록한다. 기본값을 빼앗지는 않는다 —
/// `.md` 의 기본값과 UserChoice 는 건드리지 않는다.
#[cfg(windows)]
pub fn register() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let prog = format!(r"Software\Classes\{PROG_ID}");

    let mut ok = true;
    ok &= win::set_str(&prog, None, TYPE_DESC);
    ok &= win::set_str(&format!(r"{prog}\DefaultIcon"), None, &format!("\"{}\",0", exe.display()));
    ok &= win::set_str(&format!(r"{prog}\shell"), None, "open");
    ok &= win::set_str(&format!(r"{prog}\shell\open"), Some("FriendlyAppName"), APP_NAME);
    ok &= win::set_str(&format!(r"{prog}\shell\open\command"), None, &open_command(&exe));

    for ext in EXTS {
        ok &= win::set_marker(&format!(r"Software\Classes\.{ext}\OpenWithProgids"), PROG_ID);
        ok &= win::set_str(&format!(r"{CAPS_KEY}\FileAssociations"), Some(&format!(".{ext}")), PROG_ID);
    }
    ok &= win::set_str(CAPS_KEY, Some("ApplicationName"), APP_NAME);
    ok &= win::set_str(CAPS_KEY, Some("ApplicationDescription"), APP_DESC);
    ok &= win::set_str(r"Software\RegisteredApplications", Some(APP_NAME), CAPS_KEY);

    win::notify_changed();
    if ok {
        Ok(())
    } else {
        Err("레지스트리에 연결 정보를 쓰지 못했습니다.".into())
    }
}

/// 실행할 때마다 부른다. 등록이 이 실행 파일을 가리키고 있으면 아무것도
/// 쓰지 않는다. 앱을 옮겨 설치했거나, 설치 프로그램이 따옴표 없는 명령을
/// 썼거나, 예전 판에서 올라온 경우에만 다시 쓴다.
#[cfg(windows)]
pub fn ensure_registered() {
    let Ok(exe) = std::env::current_exe() else { return };
    let prog = format!(r"Software\Classes\{PROG_ID}\shell\open\command");
    let current = win::get_str(&prog, None);
    let listed = win::get_str(r"Software\RegisteredApplications", Some(APP_NAME));
    if current.as_deref() == Some(open_command(&exe).as_str()) && listed.as_deref() == Some(CAPS_KEY) {
        return;
    }
    let _ = register();
}

/// `.md` 를 지금 우리가 열고 있는지.
#[cfg(windows)]
pub fn is_default() -> bool {
    let Ok(exe) = std::env::current_exe() else { return false };
    win::handler_of("md").map(|h| same_exe(&h, &exe)).unwrap_or(false)
}

/// 등록하고, '연결 프로그램' 창을 띄우고, 고른 결과를 돌려준다.
///
/// status: "default"  — 이제 .md 가 MD Viewer 로 열린다
///         "canceled" — 창을 그냥 닫았다
///         "other"    — 다른 앱을 골랐거나 Windows 가 선택을 저장하지 않았다
///         "failed"   — 창을 띄우지 못했다 (message 에 이유)
#[cfg(windows)]
pub fn choose(sample: &std::path::Path, parent: isize) -> Value {
    if let Err(message) = register() {
        return json!({ "status": "failed", "message": message });
    }
    if let Err(err) = std::fs::write(sample, "") {
        return json!({ "status": "failed", "message": err.to_string() });
    }

    let picked = win::open_with_dialog(sample, parent);
    let _ = std::fs::remove_file(sample);

    match picked {
        win::Picked::Failed(code) => json!({
            "status": "failed",
            "message": format!("연결 프로그램 창을 띄우지 못했습니다 ({code})."),
        }),
        _ if is_default() => json!({ "status": "default" }),
        win::Picked::Canceled => json!({ "status": "canceled" }),
        win::Picked::Done => json!({ "status": "other" }),
    }
}

/* Windows 가 아니면 기본 앱 개념이 달라 이 기능을 끈다. 렌더러는
   supported:false 를 보고 묻지 않는다. */

#[cfg(not(windows))]
pub fn ensure_registered() {}

#[cfg(not(windows))]
pub fn is_default() -> bool {
    true
}

#[cfg(not(windows))]
pub fn choose(_sample: &std::path::Path, _parent: isize) -> Value {
    json!({ "status": "failed", "message": "Windows 에서만 지원합니다." })
}
