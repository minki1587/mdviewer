'use strict';

/* ==================================================================
 * 도움말에 들어갈 내용.
 *
 * syntax : 목록에 크게 보여줄 문법 표기
 * desc   : 무엇에 쓰는지 한 줄 설명
 * sample : "넣기" 를 눌렀을 때 편집기에 들어갈 예시
 * demo   : 미리보기로 그려 볼 마크다운. 없으면 sample 을 쓴다.
 * ================================================================== */

const DEMO_IMAGE =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxODAiIGhlaWdodD0iODQiPjxyZWN0IHdpZHRoPSIxODAiIGhlaWdodD0iODQiIHJ4PSI4IiBmaWxsPSIjN2FhN2ZmIi8+PHRleHQgeD0iOTAiIHk9IjQ5IiBmb250LWZhbWlseT0ic2Fucy1zZXJpZiIgZm9udC1zaXplPSIxNSIgZmlsbD0iI2ZmZmZmZiIgdGV4dC1hbmNob3I9Im1pZGRsZSI+6re466a8PC90ZXh0Pjwvc3ZnPg==';

window.HELP_SYNTAX = [
  {
    group: '제목',
    items: [
      {
        syntax: '# 제목',
        desc: '제목 단계에 씁니다. # 을 하나씩 늘릴수록 아래 단계가 되고 여섯 개까지 쓸 수 있습니다. # 과 글자 사이에는 공백이 있어야 합니다.',
        sample: '# 제목 1\n## 제목 2\n### 제목 3\n',
      },
    ],
  },
  {
    group: '글자 꾸미기',
    items: [
      { syntax: '**굵게**', desc: '굵은 글씨로 강조합니다.', sample: '**굵게**' },
      { syntax: '*기울임*', desc: '기울인 글씨로 강조합니다. 밑줄 _기울임_ 도 같습니다.', sample: '*기울임*' },
      { syntax: '~~취소선~~', desc: '글자 가운데에 줄을 긋습니다.', sample: '~~취소선~~' },
      { syntax: '`코드`', desc: '문장 속 짧은 코드나 파일 이름을 고정폭 글꼴로 표시합니다.', sample: '`npm run dev`' },
      { syntax: '\\*', desc: '기호를 문법으로 해석하지 않고 그대로 보여줍니다. 앞에 역슬래시를 붙입니다.', sample: '\\*별표 그대로\\*' },
    ],
  },
  {
    group: '목록',
    items: [
      { syntax: '- 항목', desc: '순서 없는 목록입니다. - 대신 * 나 + 를 써도 같습니다.', sample: '- 첫째\n- 둘째\n' },
      { syntax: '1. 항목', desc: '순서 있는 목록입니다. 숫자는 실제로 쓴 값과 관계없이 차례대로 매겨집니다.', sample: '1. 첫째\n2. 둘째\n' },
      {
        syntax: '  - 하위 항목',
        desc: '앞에 공백 두 칸을 두면 한 단계 안으로 들어갑니다.',
        sample: '- 상위 항목\n  - 하위 항목\n  - 또 다른 하위 항목\n',
      },
      {
        syntax: '- [ ] 할 일',
        desc: '체크박스 목록입니다. 대괄호 안에 x 를 넣으면 완료로 표시됩니다.',
        sample: '- [x] 끝난 일\n- [ ] 남은 일\n',
      },
    ],
  },
  {
    group: '링크와 그림',
    items: [
      { syntax: '[글자](주소)', desc: '링크를 만듭니다. 바깥 주소는 기본 브라우저에서 열립니다.', sample: '[커먼마크](https://commonmark.org)' },
      {
        syntax: '[글자](문서.md)',
        desc: '같은 폴더의 다른 마크다운 문서로 연결합니다. 눌러 보면 새 탭으로 열립니다.',
        sample: '[다른 문서](./guide.md)',
        demo: '[다른 문서](https://example.com)',
      },
      {
        syntax: '[글자](#제목)',
        desc: '같은 문서 안의 제목으로 이동합니다. 제목의 공백은 붙임표로 바꿔 씁니다.',
        sample: '[설치 방법으로](#설치-방법)',
        demo: '[설치 방법으로](https://example.com)',
      },
      {
        syntax: '![설명](경로)',
        desc: '그림을 넣습니다. 문서가 있는 폴더를 기준으로 ./그림.png 처럼 상대 경로를 쓸 수 있습니다.',
        sample: '![설명](./그림.png)',
        demo: `![파란 상자](${DEMO_IMAGE})`,
      },
    ],
  },
  {
    group: '인용과 코드',
    items: [
      { syntax: '> 인용문', desc: '인용문입니다. 여러 줄이면 줄마다 > 를 붙입니다.', sample: '> 인용문입니다.\n> 다음 줄도 이어집니다.\n' },
      {
        syntax: '```언어',
        desc: '여러 줄 코드입니다. 물결표 세 개 뒤에 언어 이름을 쓰면 색이 입혀집니다.',
        sample: '```js\nconst x = 1;\n```\n',
      },
    ],
  },
  {
    group: '표',
    items: [
      {
        syntax: '| 머리 | 머리 |',
        desc: '표를 만듭니다. 두 번째 줄의 --- 이 머리글과 본문을 나눕니다. :--- 는 왼쪽, ---: 는 오른쪽, :---: 는 가운데 정렬입니다.',
        sample: '| 항목 | 값 |\n|---|---:|\n| 속도 | 빠름 |\n| 크기 | 작음 |\n',
      },
    ],
  },
  {
    group: '그 밖에',
    items: [
      { syntax: '---', desc: '가로 구분선을 긋습니다.', sample: '\n---\n' },
      {
        syntax: '(빈 줄)',
        desc: '문단을 나눕니다. 문단을 나누지 않고 줄만 바꾸려면 줄 끝에 공백 두 칸을 둡니다.',
        sample: '첫 문단입니다.\n\n다음 문단입니다.\n',
      },
      {
        syntax: '<details>',
        desc: '접었다 펼 수 있는 영역을 만듭니다. summary 안의 글자가 접힌 상태의 제목이 됩니다.',
        sample: '<details>\n<summary>펼쳐서 보기</summary>\n\n숨겨 둔 내용입니다.\n\n</details>\n',
      },
    ],
  },
];

window.HELP_KEYS = [
  {
    group: '파일과 탭',
    rows: [
      ['Ctrl+N', '새 탭'],
      ['Ctrl+O', '파일 열기 (여러 개 선택 가능)'],
      ['Ctrl+S', '저장'],
      ['Ctrl+Shift+S', '다른 이름으로 저장'],
      ['Ctrl+Alt+S', '모두 저장'],
      ['Ctrl+W', '탭 닫기'],
      ['Ctrl+Tab', '다음 탭'],
      ['Ctrl+Shift+Tab', '이전 탭'],
      ['Alt+1 … Alt+9', 'n번째 탭으로'],
      ['Ctrl+R', '디스크에서 다시 불러오기'],
    ],
  },
  {
    group: '화면',
    rows: [
      ['Ctrl+E', '읽기 ↔ 편집 전환'],
      ['Ctrl+Shift+E', '나란히 보기'],
      ['Ctrl+\\', '목차 고정'],
      ['Ctrl+D', '밝게 / 어둡게'],
      ['Ctrl+= / Ctrl+-', '글자 크게 / 작게'],
      ['Ctrl+0', '글자 크기 되돌리기'],
      ['Ctrl+휠', '글자 크기 조절'],
      ['F11', '전체 화면'],
      ['F1', '이 도움말'],
    ],
  },
  {
    group: '편집',
    rows: [
      ['Ctrl+Z / Ctrl+Shift+Z', '되돌리기 / 다시 실행'],
      ['Ctrl+F', '찾기·바꾸기'],
      ['Ctrl+B / Ctrl+I', '굵게 / 기울임'],
      ['Ctrl+`', '인라인 코드'],
      ['Ctrl+Shift+X', '취소선'],
      ['Ctrl+K', '링크 넣기'],
      ['Ctrl+1 / Ctrl+2 / Ctrl+3', '제목 1 / 2 / 3단계'],
      ['Ctrl+Shift+.', '인용문'],
      ['Ctrl+Shift+L', '목록'],
      ['Enter', '목록·인용 안에서는 기호를 이어서 붙여 줌'],
      ['Tab / Shift+Tab', '들여쓰기 / 내어쓰기'],
    ],
  },
];
