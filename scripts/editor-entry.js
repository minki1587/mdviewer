/* ------------------------------------------------------------------ *
 * 편집기 번들 — CodeMirror 6 를 renderer 에서 쓸 수 있게 묶는다.
 * 결과물: renderer/vendor/editor.js  (전역 MDEditor)
 * ------------------------------------------------------------------ */

import { EditorState } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, dropCursor, placeholder, highlightSpecialChars,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands';
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching } from '@codemirror/language';
import { markdown, markdownLanguage, markdownKeymap, insertNewlineContinueMarkup } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { tags as t } from '@lezer/highlight';

/* ----------------------------------------------------------- 문법 색상
   모든 색은 CSS 변수로 빼서 라이트/다크 전환에 그대로 따라가게 한다. */

const mdHighlight = HighlightStyle.define([
  { tag: t.heading1, color: 'var(--ed-heading)', fontWeight: '700', fontSize: '1.5em' },
  { tag: t.heading2, color: 'var(--ed-heading)', fontWeight: '700', fontSize: '1.28em' },
  { tag: t.heading3, color: 'var(--ed-heading)', fontWeight: '700', fontSize: '1.13em' },
  { tag: [t.heading4, t.heading5, t.heading6], color: 'var(--ed-heading)', fontWeight: '700' },

  { tag: t.strong, color: 'var(--ed-strong)', fontWeight: '700' },
  { tag: t.emphasis, color: 'var(--ed-strong)', fontStyle: 'italic' },
  { tag: t.strikethrough, color: 'var(--ink-low)', textDecoration: 'line-through' },

  { tag: [t.link, t.url], color: 'var(--accent)' },
  { tag: t.monospace, color: 'var(--ed-code)', fontFamily: 'var(--font-mono)' },
  { tag: t.quote, color: 'var(--ink-mid)', fontStyle: 'italic' },

  // 마크다운 기호 자체(#, *, -, >, ```)는 눈에 덜 띄게
  { tag: t.processingInstruction, color: 'var(--ed-mark)', fontWeight: '400' },
  { tag: t.list, color: 'var(--ed-mark)' },
  { tag: t.contentSeparator, color: 'var(--ed-mark)' },
  { tag: t.labelName, color: 'var(--accent)' },

  // 코드 블록 안쪽 (내장 언어)
  { tag: t.keyword, color: 'var(--hl-keyword)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--hl-string)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--hl-number)' },
  { tag: [t.function(t.variableName), t.definition(t.variableName)], color: 'var(--hl-title)' },
  { tag: [t.typeName, t.className], color: 'var(--hl-type)' },
  { tag: t.comment, color: 'var(--hl-comment)', fontStyle: 'italic' },
]);

const baseTheme = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--ink)',
    backgroundColor: 'transparent',
    fontSize: 'calc(15px * var(--scale))',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.75',
    padding: '18px 0 40vh',
    overflowX: 'hidden',
  },
  '.cm-content': { caretColor: 'var(--accent)', padding: '0' },
  '.cm-line': { padding: '0 20px 0 8px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--ed-select)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--ed-active)' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--ink-low)',
    border: 'none',
    fontSize: '.82em',
    paddingRight: '2px',
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--accent)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--ed-match)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--ed-match)',
    outline: 'none',
  },
  '.cm-panels': {
    backgroundColor: 'var(--surface)',
    color: 'var(--ink)',
    border: 'none',
    borderTop: '1px solid var(--line)',
    fontFamily: 'var(--font-body)',
    fontSize: '12.5px',
  },
  '.cm-panels input, .cm-panels button, .cm-panels label': { fontFamily: 'inherit', fontSize: '12.5px' },
  '.cm-textfield': {
    backgroundColor: 'var(--paper)',
    color: 'var(--ink)',
    border: '1px solid var(--line)',
    borderRadius: '5px',
    padding: '3px 7px',
  },
  '.cm-button': {
    backgroundColor: 'var(--paper)',
    backgroundImage: 'none',
    color: 'var(--ink)',
    border: '1px solid var(--line)',
    borderRadius: '5px',
    padding: '3px 9px',
  },
});

/* -------------------------------------------------------- 편집 명령들 */

/** 선택 영역을 기호로 감싼다. 이미 감싸져 있으면 벗긴다. */
function toggleWrap(view, before, after = before) {
  const changes = [];
  const ranges = [];
  for (const range of view.state.selection.ranges) {
    const { from, to } = range;
    const doc = view.state.doc;
    const lead = doc.sliceString(Math.max(0, from - before.length), from);
    const tail = doc.sliceString(to, Math.min(doc.length, to + after.length));

    if (lead === before && tail === after) {
      changes.push({ from: from - before.length, to: from, insert: '' });
      changes.push({ from: to, to: to + after.length, insert: '' });
      ranges.push({ anchor: from - before.length, head: to - before.length });
    } else {
      changes.push({ from, to: from, insert: before });
      changes.push({ from: to, to, insert: after });
      ranges.push({ anchor: from + before.length, head: to + before.length });
    }
  }
  view.dispatch({ changes, selection: { anchor: ranges[0].anchor, head: ranges[0].head } });
  view.focus();
  return true;
}

/** 커서가 있는 줄들의 앞에 접두어를 붙이거나 뗀다. (제목, 인용, 목록) */
function togglePrefix(view, prefix) {
  const { state } = view;
  const changes = [];
  const seen = new Set();
  for (const range of state.selection.ranges) {
    for (let n = state.doc.lineAt(range.from).number; n <= state.doc.lineAt(range.to).number; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      const line = state.doc.line(n);
      if (line.text.startsWith(prefix)) {
        changes.push({ from: line.from, to: line.from + prefix.length, insert: '' });
      } else {
        changes.push({ from: line.from, to: line.from, insert: prefix });
      }
    }
  }
  if (changes.length) view.dispatch({ changes });
  view.focus();
  return true;
}

function insertLink(view) {
  const { from, to } = view.state.selection.main;
  const label = view.state.sliceDoc(from, to);
  view.dispatch({
    changes: { from, to, insert: `[${label}]()` },
    selection: { anchor: from + label.length + 3 },
  });
  view.focus();
  return true;
}

/* ----------------------------------------------------------- 공개 API */

function create({ parent, doc = '', onChange, onScroll, onSave }) {
  const listener = EditorView.updateListener.of((update) => {
    if (update.docChanged && onChange) onChange(update.state.doc.toString());
  });

  const mdKeys = keymap.of([
    { key: 'Mod-b', run: (v) => toggleWrap(v, '**') },
    { key: 'Mod-i', run: (v) => toggleWrap(v, '*') },
    { key: 'Mod-`', run: (v) => toggleWrap(v, '`') },
    { key: 'Mod-Shift-x', run: (v) => toggleWrap(v, '~~') },
    { key: 'Mod-k', run: insertLink },
    { key: 'Mod-Shift-.', run: (v) => togglePrefix(v, '> ') },
    { key: 'Mod-Shift-l', run: (v) => togglePrefix(v, '- ') },
    { key: 'Mod-1', run: (v) => togglePrefix(v, '# ') },
    { key: 'Mod-2', run: (v) => togglePrefix(v, '## ') },
    { key: 'Mod-3', run: (v) => togglePrefix(v, '### ') },
    { key: 'Mod-s', run: () => { if (onSave) onSave(); return true; } },
    { key: 'Enter', run: insertNewlineContinueMarkup },
  ]);

  const extensions = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    highlightSpecialChars(),
    drawSelection(),
    dropCursor(),
    history(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    search({ top: false }),
    highlightSelectionMatches(),
    EditorView.lineWrapping,
    markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: false }),
    syntaxHighlighting(mdHighlight),
    placeholder('여기에 마크다운을 입력하세요…'),
    mdKeys,
    keymap.of([
      ...closeBracketsKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...markdownKeymap,
      ...defaultKeymap,
      indentWithTab,
    ]),
    listener,
    baseTheme,
  ];

  const view = new EditorView({
    parent,
    state: EditorState.create({ doc, extensions }),
  });

  if (onScroll) view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });

  return {
    view,
    getDoc: () => view.state.doc.toString(),
    /** 새 문서를 올린다. reset 이면 되돌리기 기록까지 비운다. */
    setDoc(next, { reset = true } = {}) {
      if (reset) {
        view.setState(EditorState.create({ doc: next, extensions }));
        view.scrollDOM.scrollTop = 0;
      } else {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
      }
    },
    focus: () => view.focus(),
    scrollEl: () => view.scrollDOM,
    undo: () => undo(view),
    redo: () => redo(view),
    bold: () => toggleWrap(view, '**'),
    italic: () => toggleWrap(view, '*'),
    link: () => insertLink(view),
    find: () => { view.focus(); openSearchPanel(view); },
    /** 화면 맨 위에 보이는 줄 번호 (소수점 포함, 1부터) */
    topLine() {
      const rect = view.scrollDOM.getBoundingClientRect();
      const pos = view.posAtCoords({ x: rect.left + 8, y: rect.top + 2 }, false);
      if (pos == null) return 1;
      const line = view.state.doc.lineAt(Math.max(0, Math.min(view.state.doc.length, pos)));
      // 줄 안에서 얼마나 스크롤됐는지까지 반영하면 동기화가 부드러워진다
      const block = view.lineBlockAt(line.from);
      const coords = view.coordsAtPos(line.from);
      let frac = 0;
      if (coords && block.height > 0) {
        frac = Math.min(0.999, Math.max(0, (rect.top - coords.top) / block.height));
      }
      return line.number + frac;
    },

    /**
     * 지정한 줄을 화면 맨 위로 올린다.
     * CodeMirror 는 보이는 범위만 그리므로, 멀리 떨어진 줄은 좌표를 알 수 없다.
     * 그럴 때는 먼저 대략 이동시킨 뒤 다음 프레임에 정확히 맞춘다.
     */
    scrollToLine(n) {
      const doc = view.state.doc;
      const line = doc.line(Math.max(1, Math.min(doc.lines, Math.round(n))));

      const settle = () => {
        const coords = view.coordsAtPos(line.from);
        if (!coords) return false;
        const delta = coords.top - view.scrollDOM.getBoundingClientRect().top;
        if (Math.abs(delta) > 0.5) view.scrollDOM.scrollTop += delta;
        return true;
      };

      if (!settle()) {
        view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'start' }) });
        requestAnimationFrame(settle);
      }
    },

    /** 커서가 있는 줄 번호 (1부터) */
    cursorLine: () => view.state.doc.lineAt(view.state.selection.main.head).number,
    lineCount: () => view.state.doc.lines,
    stats() {
      const text = view.state.doc.toString();
      return {
        chars: text.length,
        words: (text.trim().match(/[\p{L}\p{N}]+/gu) || []).length,
        lines: view.state.doc.lines,
      };
    },
  };
}

export { create };
