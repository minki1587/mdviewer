# MD Viewer

마크다운 뷰어 겸 편집기. Windows용 설치 파일(.exe)을 만들고 `.md` 파일의
기본 프로그램으로 지정할 수 있습니다.

기본 화면은 **나란히 보기**입니다. 왼쪽 편집기에서 고치면 오른쪽 미리보기가
바로 따라오고, 두 화면의 스크롤은 제목을 기준으로 맞춰집니다.
읽기 전용, 편집 전용 화면으로도 바꿀 수 있습니다.

## 1. 개발 환경에서 실행

Node.js 20 이상이 필요합니다.

```bash
npm install
npm run dev        # sample.md 를 열면서 실행
npm start          # 빈 화면으로 실행
```

`npm start` / `npm run dev` 는 실행 전에 편집기 번들(`renderer/vendor/editor.js`)을
자동으로 다시 만듭니다. 따로 빌드할 필요는 없습니다.

## 2. 설치 파일 만들기

Windows에서 실행해야 NSIS 설치 파일이 만들어집니다.

```bash
npm run dist
```

`dist/MD Viewer-1.0.0-setup.exe` 가 생성됩니다.
설치 중 폴더 선택이 가능하고, 관리자 권한 없이 현재 사용자 계정에만 설치됩니다.

실행 파일만 확인하려면 `npm run dist:dir` → `dist/win-unpacked/MD Viewer.exe`.

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

### 파일

| 동작 | 단축키 |
|---|---|
| 새 문서 | `Ctrl+N` |
| 열기 | `Ctrl+O` — 창 안으로 드래그 앤 드롭도 됩니다 |
| 저장 | `Ctrl+S` |
| 다른 이름으로 저장 | `Ctrl+Shift+S` |
| 디스크에서 다시 불러오기 | `Ctrl+R` |

저장하지 않은 변경이 있으면 파일 이름 옆에 점이 뜨고, 다른 파일을 열거나
창을 닫을 때 저장할지 물어봅니다.

### 화면

| 동작 | 단축키 |
|---|---|
| 읽기 ↔ 편집 전환 | `Ctrl+E` |
| 나란히 보기 | `Ctrl+Shift+E` |
| 목차 고정 | `Ctrl+\` — 평소엔 왼쪽 레일에 마우스를 올리면 펼쳐집니다 |
| 밝게 / 어둡게 | `Ctrl+D` |
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

## 5. 구조

```
main.js                 창 생성, 파일 열기·저장, 파일 감시, 메뉴, 설정 저장
preload.js              마크다운 → 안전한 HTML 변환 (marked + DOMPurify + highlight.js)
renderer/index.html     화면 구조
renderer/style.css      테마 토큰, 리딩 레일, 본문 타이포그래피, 편집기 스타일
renderer/renderer.js    문서 표시, 부분 갱신, 모드 전환, 저장 흐름, 스크롤 동기화
renderer/vendor/        scripts/ 에서 생성되는 편집기 번들 (직접 고치지 않음)
scripts/editor-entry.js CodeMirror 6 설정 — 문법 강조, 편집 명령
scripts/build-editor.mjs esbuild 번들 스크립트
assets/icon.ico         앱 및 파일 연결 아이콘
```

마크다운 파싱은 렌더러가 아니라 preload에서 처리하고, 결과를 DOMPurify로 걸러
`contextIsolation`을 켠 채로 문서를 표시합니다. 문서 안의 스크립트는 실행되지 않습니다.

편집 중인 파일이 다른 프로그램에서 바뀌면, 편집 내용을 덮어쓰지 않고
알림만 띄웁니다. 저장하지 않은 상태가 아니라면 자동으로 다시 불러옵니다.

## 6. 손볼 만한 곳

- 아이콘 교체: `assets/icon.ico` (256×256 포함 다중 크기 .ico)
- 앱 이름·ID: `package.json` 의 `build.productName`, `build.appId`
- 연결할 확장자: `package.json` 의 `build.fileAssociations[0].ext`
- 본문 폭·글꼴: `renderer/style.css` 의 `--measure`, `--font-body`
- 편집기 색상: `renderer/style.css` 의 `--ed-*` 변수
- 편집 단축키: `scripts/editor-entry.js` 의 `mdKeys`
