// Plain pages served outside the app: the privacy policy (PRIVACY.md) and the terms (TERMS.md), open without signing
// in so someone can read them before requesting access. A small Markdown subset (headings, paragraphs, bullets, bold,
// code and links), escaped first.
import { readFileSync } from 'node:fs';
import { repoPath } from '../tools/paths.js';

const escape = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const inline = (s) => escape(s)
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*|mailto:[^)\s@<>"']+@[^)\s@<>"']+)\)/g, '<a href="$2">$1</a>');

/** The support address from SUPPORT_EMAIL, or null when unset or not an address (pages then name the administrator). */
export const supportEmailFrom = (value) => (/^[^\s@<>"'()[\]]+@[^\s@<>"'()[\]]+\.[A-Za-z]{2,}$/.test(String(value ?? '').trim()) ? String(value).trim() : null);

/** HTML for the Markdown subset the policy files use. */
export function markdownToHtml(md) {
  const out = [];
  let list = false;
  for (const line of String(md).split(/\r?\n/)) {
    const bullet = /^\s*[-*] (.*)$/.exec(line);
    if (!bullet && list) { out.push('</ul>'); list = false; }
    const h = /^(#{1,3}) (.*)$/.exec(line);
    if (h) out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    else if (bullet) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(bullet[1])}</li>`); }
    else if (line.trim()) out.push(`<p>${inline(line.trim())}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('\n');
}

/**
 * A full page around a policy file. notice ({ text, linkText, href }) puts a banner above it: the demo's guides say they
 * are the demo's copy and link to Request access.
 */
export function policyPage(file, vars = {}, { notice = null } = {}) {
  // {{SITE}} and {{SUPPORT}} are filled in at render time, so the repo never names the live address or the support
  // mailbox; without SUPPORT_EMAIL, {{SUPPORT}} reads "the administrator".
  const support = vars.SUPPORT ? `[${vars.SUPPORT}](mailto:${vars.SUPPORT})` : 'the administrator';
  const md = readFileSync(repoPath(file), 'utf8').replace(/\{\{(\w+)\}\}/g, (m, k) => (k === 'SUPPORT' ? support : vars[k] ?? m));
  const title = /^# (.*)$/m.exec(md)?.[1] ?? 'Health Review';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>` +
    '<style>body{font:16px/1.55 system-ui,sans-serif;margin:0;background:#f4f3f0;color:#1d1d1b}main{max-width:720px;margin:0 auto;padding:24px 16px}' +
    '@media (prefers-color-scheme: dark){body{background:#121211;color:#e8e7e3}a{color:#6da7ec}}h1{font-size:24px}h2{font-size:18px;margin-top:28px}code{word-break:break-all}</style></head>' +
    `<body><main>${notice ? `<p style="border:2px solid #2a78d6;border-radius:8px;padding:10px 12px">${escape(notice.text)}${notice.href ? ` <a href="${escape(notice.href)}">${escape(notice.linkText ?? notice.href)}</a>.` : ''}</p>` : ''}${markdownToHtml(md)}<p><a href="/">Back to Health Review</a></p></main></body></html>`;
}
