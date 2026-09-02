# MD Viewer 샘플 문서

이 파일은 뷰어가 제대로 동작하는지 확인하는 용도입니다.
`npm run dev` 로 실행하면 이 문서가 바로 열립니다.

## 텍스트 서식

**굵게**, *기울임*, ~~취소선~~, `인라인 코드`, [외부 링크](https://commonmark.org).

> 인용문은 왼쪽에 강조선이 붙습니다.
> 여러 줄도 이어집니다.

## 목록

1. 순서 있는 목록
2. 두 번째 항목
   - 중첩된 항목
   - 또 다른 항목

- [x] 끝난 일
- [ ] 남은 일

## 표

| 기능 | 상태 | 단축키 |
|---|---|---:|
| 파일 열기 | 완료 | Ctrl+O |
| 목차 고정 | 완료 | Ctrl+\ |
| 화면 전환 | 완료 | Ctrl+D |

## 코드

```js
async function loadDoc(filePath) {
  const text = await fs.promises.readFile(filePath, 'utf8');
  return render(text, path.dirname(filePath));
}
```

```python
def slugify(text: str) -> str:
    return re.sub(r"[^\w\-]", "", text.lower().replace(" ", "-"))
```

## 접기

<details>
<summary>펼쳐서 보기</summary>

숨겨둔 내용도 그대로 표시됩니다.

</details>

---

## 긴 문서 확인용

왼쪽 가장자리에 얇은 세로 띠가 보입니다. 제목마다 눈금이 하나씩 쌓이고,
지금 읽고 있는 위치의 눈금이 파랗게 켜집니다. 마우스를 올리면 제목 글자가 펼쳐지고,
클릭하면 그 자리로 이동합니다. Ctrl+\ 로 항상 펼쳐 둘 수도 있습니다.

### 하위 제목 A
내용입니다.

### 하위 제목 B
내용입니다.

### 하위 제목 C
내용입니다.

