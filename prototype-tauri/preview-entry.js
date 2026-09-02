/* Tauri 이식 시 preload.js 의 마크다운 변환부가 웹 계층으로 옮겨온 모습.
   크기 측정이 목적이므로 API 표면만 맞춰 둔다. */

import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';

function render(text) {
  const html = marked.parse(text, { gfm: true, breaks: false });
  return DOMPurify.sanitize(html, { RETURN_TRUSTED_TYPE: false });
}

function highlight(el) {
  const lang = (el.className.match(/language-([\w-]+)/) || [])[1];
  const source = el.textContent || '';
  const out = lang && hljs.getLanguage(lang)
    ? hljs.highlight(source, { language: lang, ignoreIllegals: true })
    : hljs.highlightAuto(source);
  el.innerHTML = out.value;
  el.classList.add('hljs');
}

window.__preview = { render, highlight };
