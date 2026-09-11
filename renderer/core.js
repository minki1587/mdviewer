'use strict';

/*
 * 렌더러가 쓰는 순수 로직을 한곳에 둔다.
 *
 * 브라우저에서는 window.MVCore 로, Node 테스트에서는 module.exports 로
 * 내보낸다. 화면 코드의 복사본을 따로 시험하지 않고 실제 앱이 부르는 함수
 * 자체를 검사하기 위한 작은 경계다.
 */
(function (root, factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  else root.MVCore = core;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SHORTCUTS = Object.freeze({
    'Ctrl+N': 'doc:new',
    'Ctrl+O': 'files:pick',
    'Ctrl+S': 'doc:save',
    'Ctrl+Shift+S': 'doc:save-as',
    'Ctrl+Alt+S': 'doc:save-all',
    'Ctrl+P': 'doc:export-pdf',
    'Ctrl+R': 'doc:reload',
    'Ctrl+W': 'tab:close',
    'Ctrl+Tab': 'tab:next',
    'Ctrl+Shift+Tab': 'tab:prev',
    'Ctrl+E': 'view:mode:toggle',
    'Ctrl+Shift+E': 'view:mode:split',
    'Ctrl+\\': 'view:toggle-toc',
    'Ctrl+D': 'view:toggle-theme',
    'Ctrl+=': 'view:zoom:in',
    'Ctrl+Shift+=': 'view:zoom:in',
    'Ctrl+-': 'view:zoom:out',
    'Ctrl+0': 'view:zoom:reset',
    'Ctrl+F': 'edit:find',
    'Ctrl+Z': 'edit:undo',
    'Ctrl+Shift+Z': 'edit:redo',
    'Ctrl+B': 'edit:bold',
    'Ctrl+I': 'edit:italic',
    'Ctrl+K': 'edit:link',
    F1: 'help:syntax',
    F11: 'view:fullscreen',
    F12: 'view:devtools',
  });

  function withMods(event, key) {
    const parts = [];
    if (event.ctrlKey || event.metaKey) parts.push('Ctrl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    parts.push(key);
    return parts.join('+');
  }

  /** 눌린 조합을 `Ctrl+Shift+S` 같은 한 줄로 만든다. */
  function comboOf(event) {
    let key = event.key;
    if (key === '+') key = '=';
    if (key.length === 1) key = key.toUpperCase();
    return withMods(event, key);
  }

  /** 한글 IME가 자모를 key로 줄 때 물리 키 위치를 보조 수단으로 쓴다. */
  function comboByCode(event) {
    const match = /^Key([A-Z])$/.exec(event.code) || /^Digit([0-9])$/.exec(event.code);
    return match ? withMods(event, match[1]) : null;
  }

  function shortcutFor(event, shortcuts = SHORTCUTS) {
    const byCode = comboByCode(event);
    return shortcuts[comboOf(event)] || (byCode ? shortcuts[byCode] : undefined);
  }

  /** 읽기 본문 너비를 정해진 범위와 간격에 맞춘다. */
  function normalizeMeasure(value, {
    min = 48,
    max = 110,
    step = 2,
    fallback = 74,
  } = {}) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    const clamped = Math.min(max, Math.max(min, numeric));
    return min + Math.round((clamped - min) / step) * step;
  }

  /* 인용문 안(`> - [ ]`)도 체크박스로 그려지므로 `>`를 넘겨 가며 읽는다. */
  const TASK_LINE = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)([ xX])(?=\])/;
  const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

  /** 원문에서 n번째 할 일 항목의 상태 글자가 몇 번째 글자인지 찾는다. */
  function taskCharAt(text, nth) {
    if (!Number.isInteger(nth) || nth < 0) return null;

    const lines = String(text).split('\n');
    let seen = -1;
    let offset = 0;
    let fence = null;

    for (const line of lines) {
      const marker = line.match(FENCE);
      if (marker) {
        if (!fence) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      } else if (!fence) {
        const match = line.match(TASK_LINE);
        if (match && ++seen === nth) {
          return {
            at: offset + match[1].length,
            on: match[2].toLowerCase() === 'x',
          };
        }
      }
      offset += line.length + 1;
    }
    return null;
  }

  /** 대소문자를 구분하지 않는 겹치지 않는 검색 결과의 [시작, 끝] 목록. */
  function findTextOffsets(text, query, limit = 2000) {
    if (!String(query).trim() || limit <= 0) return [];

    const haystack = String(text).toLowerCase();
    const needle = String(query).toLowerCase();
    const matches = [];
    let at = haystack.indexOf(needle);
    while (at !== -1 && matches.length < limit) {
      matches.push([at, at + needle.length]);
      at = haystack.indexOf(needle, at + needle.length);
    }
    return matches;
  }

  /** 본문의 텍스트 노드와 이어 붙인 문자열을 함께 만든다. */
  function textHaystack(rootElement) {
    const doc = rootElement.ownerDocument;
    const showText = doc.defaultView?.NodeFilter?.SHOW_TEXT ?? 4;
    const walker = doc.createTreeWalker(rootElement, showText);
    const nodes = [];
    let text = '';
    let node;
    while ((node = walker.nextNode())) {
      nodes.push({ node, start: text.length });
      text += node.nodeValue;
    }
    return { nodes, text };
  }

  /** 이어 붙인 문자열의 [from, to)를 실제 DOM Range로 되돌린다. */
  function textRange(doc, nodes, from, to) {
    if (!nodes.length) return null;

    const locate = (position) => {
      let low = 0;
      let high = nodes.length - 1;
      let found = 0;
      while (low <= high) {
        const middle = (low + high) >> 1;
        if (nodes[middle].start <= position) {
          found = middle;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      return [nodes[found].node, position - nodes[found].start];
    };

    const [startNode, startOffset] = locate(from);
    const [endNode, endOffset] = locate(to);
    const range = doc.createRange();
    range.setStart(startNode, Math.min(startOffset, startNode.nodeValue.length));
    range.setEnd(endNode, Math.min(endOffset, endNode.nodeValue.length));
    return range;
  }

  function sessionPlan(session, limit = 30) {
    const supplied = Array.isArray(session?.paths) ? session.paths : [];
    const valid = supplied.filter((path) => typeof path === 'string' && path.length > 0);
    const paths = valid.slice(0, Math.max(0, limit));
    return {
      paths,
      active: typeof session?.active === 'string' ? session.active : null,
      skipped: Math.max(0, valid.length - paths.length),
    };
  }

  /** 세션 파일을 병렬로 읽되, 한 파일의 실패가 앱 시작을 막지 않게 한다. */
  async function loadSessionDocuments(session, readFile, limit = 30) {
    const plan = sessionPlan(session, limit);
    const loaded = await Promise.all(plan.paths.map(async (path) => {
      try {
        return await readFile(path) || null;
      } catch {
        return null;
      }
    }));
    return {
      ...plan,
      documents: loaded.filter(Boolean),
      missing: loaded.filter((document) => !document).length,
    };
  }

  return Object.freeze({
    SHORTCUTS,
    comboOf,
    comboByCode,
    shortcutFor,
    normalizeMeasure,
    taskCharAt,
    findTextOffsets,
    textHaystack,
    textRange,
    sessionPlan,
    loadSessionDocuments,
  });
});
