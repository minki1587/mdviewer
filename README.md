# MD Viewer

마크다운 뷰어 겸 편집기. Windows용 설치 파일(.exe)을 만들고 `.md` 파일의
기본 프로그램으로 지정할 수 있습니다.

여러 문서를 **탭**으로 열어 오갈 수 있습니다. 탭마다 본문, 커서 위치,
되돌리기 기록, 스크롤 위치가 따로 유지됩니다.

기본 화면은 **나란히 보기**입니다. 왼쪽 편집기에서 고치면 오른쪽 미리보기가
바로 따라오고, 두 화면의 스크롤은 제목을 기준으로 맞춰집니다.
읽기 전용, 편집 전용 화면으로도 바꿀 수 있습니다.

## 1. 개발 환경에서 실행

창과 파일 입출력은 Rust(Tauri 2), 화면은 웹 기술로 되어 있습니다. 그래서
준비물이 셋입니다.

- **Node.js 20 이상** — 화면 쪽 번들을 만듭니다
- **Rust (stable)** — <https://rustup.rs>
- **MSVC 빌드 도구** — Visual Studio Build Tools 의 "C++ 데스크톱 개발" 워크로드
  (Windows 10/11 SDK 포함)

화면은 시스템에 이미 깔려 있는 **WebView2**(Edge)를 씁니다. Windows 11 에는
기본으로 들어 있고, 없으면 설치 파일이 알아서 받아 옵니다.

```bash
npm install
npm run dev        # 개발 모드로 실행
```

`npm run dev` / `npm run build` 는 실행 전에 웹 번들
(`renderer/vendor/editor.js`, `renderer/vendor/api.js`)을 자동으로 다시 만듭니다.
따로 빌드할 필요는 없습니다.

문서를 열어 둔 채로 시작하려면 인자로 넘기면 됩니다.

```bash
npm run dev -- -- sample.md
```

## 2. 설치 파일 만들기

Windows에서 실행해야 NSIS 설치 파일이 만들어집니다.

```bash
npm run build
```

`src-tauri/target/release/bundle/nsis/MD Viewer_1.3.1_x64-setup.exe` 가 생성됩니다.
설치 파일은 약 2.5MB, 설치 후 차지하는 자리는 약 5.5MB 입니다.
설치 중 폴더 선택이 가능하고, 관리자 권한 없이 현재 사용자 계정에만 설치됩니다.

실행 파일만 확인하려면 `src-tauri/target/release/md-viewer.exe` 를 그대로
실행하면 됩니다. 화면 파일은 실행 파일 안에 들어 있어서 따로 챙길 것이 없습니다.

## 3. `.md` 기본 프로그램으로 지정

설치 프로그램이 `.md`, `.markdown`, `.mdown`, `.mkd` 확장자를 레지스트리에 등록하지만,
Windows 10/11은 보안상 기본 앱을 프로그램이 스스로 바꾸지 못하게 막습니다.
설치 후 한 번만 직접 지정해 주세요.

**방법 A — 파일에서 바로**
`.md` 파일 우클릭 → **연결 프로그램** → **다른 앱 선택** → `MD Viewer` →
**항상 이 앱을 사용하여 .md 파일 열기** 체크 → 확인

**방법 B — 설정에서**
설정 → 앱 → 기본 앱 → `MD Viewer` 검색 → `.md` 항목을 MD Viewer로 변경

지정 후에는 `.md` 파일을 더블클릭하면 바로 열립니다.
이미 실행 중이면 새 창을 띄우지 않고 기존 창에서 문서를 바꿉니다.

## 4. 조작

### 파일과 탭

| 동작 | 단축키 |
|---|---|
| 새 탭 | `Ctrl+N` — 탭 줄 오른쪽 `+` 도 같습니다 |
| 열기 | `Ctrl+O` — 여러 개를 한 번에 고를 수 있습니다 |
| 저장 | `Ctrl+S` |
| 다른 이름으로 저장 | `Ctrl+Shift+S` |
| 모두 저장 | `Ctrl+Alt+S` |
| 탭 닫기 | `Ctrl+W` — 탭 가운데 버튼 클릭도 같습니다 |
| 다음 / 이전 탭 | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| n번째 탭 | `Alt+1` ~ `Alt+9` |
| 디스크에서 다시 불러오기 | `Ctrl+R` |

창 안으로 `.md` 파일을 끌어다 놓으면 탭으로 열립니다. 여러 개를 한꺼번에
놓아도 됩니다. 이미 열려 있는 파일을 다시 열면 새 탭을 만들지 않고 그 탭으로
이동합니다. 탭은 끌어서 순서를 바꿀 수 있습니다.

저장하지 않은 탭에는 이름 옆에 점이 뜹니다. 그 탭을 닫으면 저장할지 물어보고,
창을 닫을 때는 저장하지 않은 탭이 몇 개인지 알려준 뒤 한꺼번에 저장할 수 있습니다.

### 화면

| 동작 | 단축키 |
|---|---|
| 읽기 ↔ 편집 전환 | `Ctrl+E` |
| 나란히 보기 | `Ctrl+Shift+E` |
| 목차 고정 | `Ctrl+\` — 평소엔 왼쪽 레일에 마우스를 올리면 펼쳐집니다 |
| 밝게 / 어둡게 | `Ctrl+D` |
| 마크다운 문법 도움말 | `F1` |
| 글자 크기 | `Ctrl` `+` / `-` / `0`, 또는 `Ctrl` + 휠 |

나란히 보기에서는 가운데 경계선을 끌어 너비를 바꿀 수 있고,
두 번 클릭하면 반반으로 돌아갑니다.

**스크롤 동기화** — 단순히 높이 비율만 맞추면 그림이나 코드 블록에서 금방
어긋납니다. 그래서 원문의 제목 줄과 미리보기의 제목 위치를 짝지어 두고
그 사이를 비례로 채웁니다. 제목이 없는 문서에서는 전체 비율로 되돌아갑니다.
먼저 움직인 쪽이 주도권을 갖기 때문에 두 화면이 서로를 밀며 떨리지 않습니다.

**실시간 반영** — 입력하면 전체를 다시 그리지 않고, 앞뒤로 같은 부분은 두고
달라진 블록만 바꿉니다. 화면이 깜빡이지 않고 이미지도 다시 불러오지 않습니다.
반영까지 걸리는 시간은 문서 크기에 맞춰 자동으로 조절됩니다.

### 편집

| 동작 | 단축키 |
|---|---|
| 되돌리기 / 다시 실행 | `Ctrl+Z` / `Ctrl+Shift+Z` |
| 찾기·바꾸기 | `Ctrl+F` |
| 굵게 / 기울임 | `Ctrl+B` / `Ctrl+I` |
| 인라인 코드 / 취소선 | ``Ctrl+` `` / `Ctrl+Shift+X` |
| 링크 삽입 | `Ctrl+K` |
| 제목 1·2·3 | `Ctrl+1` / `Ctrl+2` / `Ctrl+3` |
| 인용문 / 목록 | `Ctrl+Shift+.` / `Ctrl+Shift+L` |

목록이나 인용문 안에서 `Enter` 를 누르면 기호가 자동으로 이어집니다.

## 5. 도움말

`F1` 또는 상단 바의 물음표 버튼을 누르면 마크다운 문법 목록이 열립니다.
각 항목은 왼쪽에 쓰는 법과 설명, 오른쪽에 이 앱이 실제로 그려내는 결과를
나란히 보여줍니다. 미리보기는 본문과 똑같은 렌더링 경로를 타기 때문에
도움말에서 본 그대로가 문서에도 나옵니다.

**넣기** 를 누르면 그 예시가 커서 자리에 들어갑니다. 위쪽 검색창에서 문법
표기나 설명으로 걸러 볼 수 있고, **단축키** 탭으로 넘기면 전체 단축키 목록이
나옵니다. `Esc` 나 바깥 클릭으로 닫습니다.

## 6. GitHub에 올리고 자동 업데이트 붙이기

설치된 앱이 GitHub 릴리스를 보고 새 버전을 찾아옵니다.
저장소를 만든 뒤 아래 순서대로 하면 됩니다.

### 저장소 지정

```bash
npm run setup:repo -- <내계정>/md-viewer
```

`package.json` 의 `repository` 와 `src-tauri/tauri.conf.json` 의 업데이트 확인 주소를
한꺼번에 채웁니다. 둘 중 하나만 바꿔 두면 업데이트가 동작하지 않으니 이 명령을
쓰는 편이 안전합니다.

### 업데이트 서명 키

Tauri 업데이터는 내려받은 설치 파일의 서명을 확인합니다. 키가 없으면 업데이트가
동작하지 않습니다.

```bash
npx tauri signer generate -w ~/.tauri/mdviewer.key
```

- 공개키는 `src-tauri/tauri.conf.json` 의 `plugins.updater.pubkey` 에 넣습니다.
  (저장소에 올라가도 되는 값입니다)
- 개인키는 **절대 저장소에 넣지 마세요.** GitHub 저장소의
  Settings → Secrets and variables → Actions 에 아래 두 개를 등록합니다.

| 시크릿 | 값 |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | 개인키 파일 내용 전체 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 개인키 암호 (없으면 빈 값) |

키를 잃어버리면 이미 설치된 앱들에 업데이트를 내보낼 수 없습니다. 따로 백업해
두세요.

### 올리기

```bash
git remote add origin https://github.com/<내계정>/md-viewer.git
git add -A
git commit -m "저장소 설정"
git branch -M main
git push -u origin main
```

### 새 버전 내보내기

```bash
npm version 1.4.0        # package.json 갱신 + 커밋 + v1.4.0 태그
git push origin main
```

`main` 에 푸시되면 `.github/workflows/release.yml` 이 Windows 러너에서 설치 파일을
만들어 GitHub 릴리스에 올립니다. 릴리스와 `v1.4.0` 태그는 워크플로가 만들므로
따로 태그를 밀 필요는 없습니다. 함께 올라가는 `latest.json` 이 버전 정보이고,
설치된 앱은 이 파일을 보고 새 버전을 판단합니다. 서명 파일(`.sig`)도 같이
올라가며, 앱은 서명이 맞을 때만 설치를 진행합니다.

릴리스는 `package.json` 의 `version` 이 올라간 푸시에서만 만들어집니다. 같은
버전으로 다시 푸시하면 워크플로가 이미 발행된 릴리스를 확인하고 조용히 넘어가므로,
문서 수정 같은 커밋이 빌드를 돌리지 않습니다. **버전은 `npm version` 으로만
올리세요.** `package.json` 을 손으로 고치면 커밋과 태그가 따로 놀게 됩니다.

별도 토큰은 필요 없습니다. 워크플로가 GitHub이 자동으로 주는 `GITHUB_TOKEN` 을
씁니다. 서명 키 두 개만 시크릿으로 넣어 두면 됩니다. 저장소가 비공개면 앱이
릴리스를 읽지 못하니 공개로 두어야 합니다.

### 앱에서 보이는 모습

앱을 켜고 8초 뒤, 그리고 4시간마다 조용히 확인합니다. 새 버전이 있을 때만
오른쪽 아래에 알림이 뜹니다. **도움말 → 업데이트 확인** 으로 직접 확인하면
최신이어도 결과를 알려줍니다.

설치 파일이 작아졌지만 흐름은 그대로입니다. 자동으로 받지 않고 먼저 물어봅니다.
**내려받기** 를 누르면 진행률이 보이고, 끝나면 **지금 다시 시작** 으로 설치합니다.
저장하지 않은 문서가 있으면 다시 시작하기 전에 먼저 저장합니다.

### 개발 중에 업데이트 흐름 확인하기

개발 빌드에서는 확인을 건너뜁니다. 흐름을 시험해 보려면
`MD_VIEWER_DEV_UPDATE=1` 을 켠 채로 실행하세요. 그러면 개발 빌드에서도
`tauri.conf.json` 의 `plugins.updater.endpoints` 주소를 보러 갑니다.

```bash
MD_VIEWER_DEV_UPDATE=1 npm run dev
```

### 서명에 관해

여기서 말하는 서명은 두 가지로 나뉩니다.

- **업데이트 서명** — 위에서 만든 Tauri 키. 자동 업데이트에 반드시 필요합니다.
- **코드 서명** — Windows SmartScreen 경고를 없애는 인증서. 없어도 설치와
  업데이트는 동작하며, 설치할 때마다 경고가 뜰 뿐입니다. 인증서가 있다면
  `src-tauri/tauri.conf.json` 의 `bundle.windows` 에 `certificateThumbprint`
  (또는 `signCommand`) 를 넣으면 사라집니다.

## 7. 구조

```
src-tauri/src/main.rs      창, 커맨드, 메뉴 처리, 종료 확인, 시작 순서
src-tauri/src/menu.rs      상단 메뉴와 단축키
src-tauri/src/docs.rs      문서 읽기, 마크다운 파일 판별, 실행 인자 해석
src-tauri/src/settings.rs  테마·글자 크기·화면 구성 저장
src-tauri/src/watcher.rs   열린 탭의 파일이 바깥에서 바뀌는지 지켜보기
src-tauri/src/update.rs    GitHub 릴리스 확인·내려받기·설치
src-tauri/tauri.conf.json  창 설정, CSP, 파일 연결, NSIS, 업데이터 주소·공개키
src-tauri/capabilities/    화면에 허용하는 권한
renderer/index.html        화면 구조
renderer/style.css         테마 토큰, 리딩 레일, 본문 타이포그래피, 편집기 스타일
renderer/renderer.js       탭 관리, 문서 표시, 부분 갱신, 저장 흐름, 스크롤 동기화
renderer/help-data.js      도움말에 실리는 마크다운 문법·단축키 목록
renderer/vendor/           scripts/ 에서 생성되는 번들 (직접 고치지 않음)
scripts/api-entry.js       window.api — 커맨드 래퍼 + 마크다운 → 안전한 HTML 변환
scripts/editor-entry.js    CodeMirror 6 설정 — 문법 강조, 편집 명령
scripts/build-api.mjs      window.api 번들 스크립트
scripts/build-editor.mjs   편집기 번들 스크립트
assets/icon.ico            앱 및 파일 연결 아이콘
.github/workflows/         main 에 푸시되면 설치 파일을 만들어 릴리스에 올리는 작업
```

화면 쪽은 `window.api` 하나만 보고 움직입니다. `renderer.js` 는 Rust 를 직접
부르지 않고, `scripts/api-entry.js` 가 그 표면을 만들어 Tauri 커맨드와 이벤트로
옮겨 줍니다. 창·파일·메뉴처럼 시스템에 닿는 일은 모두 Rust 쪽에 있습니다.

마크다운 파싱은 화면 쪽에서 하고, 결과를 DOMPurify로 걸러서 표시합니다.
문서 안의 스크립트는 실행되지 않습니다. 문서에 딸린 로컬 이미지는 Tauri 의
asset 프로토콜을 거쳐 들어옵니다. WebView2 는 `file://` 을 직접 읽지 못하기
때문입니다.

열려 있는 탭의 파일은 모두 감시합니다. 다른 프로그램에서 파일이 바뀌면
그 탭을 수정 중이 아닐 때만 조용히 다시 불러오고, 수정 중이라면 덮어쓰지 않고
알림만 띄웁니다.

편집기 인스턴스는 하나만 두고 탭마다 CodeMirror 의 `EditorState` 를 따로 들고
있다가 전환할 때 갈아 끼웁니다. 상태 하나에 본문·커서·되돌리기 기록이 모두
들어 있어서 탭이 늘어도 편집기가 여러 개 뜨지 않습니다. 미리보기는 그린 결과를
탭에 캐시해 두고 전환할 때 다시 파싱하지 않습니다.

## 8. 손볼 만한 곳

- 아이콘 교체: `assets/icon.ico` (256×256 포함 다중 크기 .ico), `assets/icon.png`
- 앱 이름·ID: `src-tauri/tauri.conf.json` 의 `productName`, `identifier`
- 연결할 확장자: `src-tauri/tauri.conf.json` 의 `bundle.fileAssociations[0].ext`
  (`src-tauri/src/docs.rs` 의 `MD_EXTS` 와 `scripts/api-entry.js` 의 `MD_EXTS` 도 함께)
- 본문 폭·글꼴: `renderer/style.css` 의 `--measure`, `--font-body`
- 편집기 색상: `renderer/style.css` 의 `--ed-*` 변수
- 편집 단축키: `scripts/editor-entry.js` 의 `mdKeys`
- 메뉴 단축키: `src-tauri/src/menu.rs`
- GitHub 저장소: `npm run setup:repo -- <계정>/<저장소>`
- 업데이트 확인 주기: `src-tauri/src/main.rs` 의 `setup` 안에 있는 `4 * 60 * 60`
- 파일 감시 주기: `src-tauri/src/watcher.rs` 의 `POLL`
- 도움말 항목: `renderer/help-data.js` — `syntax`(표기), `desc`(설명),
  `sample`(넣을 예시), `demo`(미리보기용, 없으면 sample) 네 가지로 되어 있습니다
