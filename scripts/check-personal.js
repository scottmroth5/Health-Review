// Blocks commits that contain personal data or secrets (the repo is public). Ported from Job-Agent's check.
//   node scripts/check-personal.js          check staged files (what the pre-commit hook runs)
//   node scripts/check-personal.js --all    check every tracked file (what CI runs)
// Always, including CI: paths that must never be committed (data/, .env, health exports, keys, backups) and the shapes of
// real secrets (API keys, OAuth client secrets, tokens, private keys). On this computer also: every value in .env (8+
// characters, app options excepted) and the owner's own terms in data/private-terms.txt (gitignored; one per line,
// "allow: text" lines are blanked out first). Hits print the file, line and a masked term, never the value.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { repoPath } from '../tools/paths.js';

const ENV_MIN_LENGTH = 8; // shorter .env values (flags, small numbers) would only produce noise

// .env settings that are app options, not secrets or personal values, so their values (like "daily 07:00" or
// "America/New_York") may appear in code and docs. Everything else in .env is treated as private.
export const NON_SECRET_ENV_KEYS = new Set(['AUTH_MODE', 'APPLE_SOURCE', 'OWNER_TZ', 'HOST', 'PORT', 'TRUST_PROXY', 'REVIEW_MODEL', 'REVIEW_EFFORT', 'DATA_DIR']);
const nonSecretKey = (key) => NON_SECRET_ENV_KEYS.has(key) || key.startsWith('SCHEDULE_');

// Real secrets by shape (built so this file never matches itself).
export const SECRET_SHAPES = [
  { name: 'Anthropic API key', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'Google API key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'Google OAuth client secret', re: /GOCSPX-[0-9A-Za-z_-]{20,}/ },
  { name: 'GitHub token', re: /\b(?:gh[pousr]_[0-9A-Za-z]{30,}|github_pat_[0-9A-Za-z_]{30,})\b/ },
  { name: 'private key', re: new RegExp(['-----BEGIN', '(?:[A-Z]+ )*PRIVATE KEY-----'].join(' ')) },
];

/**
 * Finds private terms in text. Matching is case-insensitive and whole-word where the term starts and ends with a letter
 * or digit. allowTerms are blanked out first, so a public handle that contains a private word does not trip.
 * @returns {Array<{line: number, term: number}>} 1-based line numbers and indexes into terms
 */
export function findPersonalHits(text, terms, allowTerms = []) {
  let scrubbed = text;
  for (const allow of allowTerms) scrubbed = scrubbed.replace(new RegExp(escapeRegex(allow), 'gi'), (m) => ' '.repeat(m.length));
  const patterns = terms.map((t) => {
    const e = escapeRegex(t.trim());
    const start = /^[\p{L}\p{N}]/u.test(t.trim()) ? '(?<![\\p{L}\\p{N}])' : '';
    const end = /[\p{L}\p{N}]$/u.test(t.trim()) ? '(?![\\p{L}\\p{N}])' : '';
    return new RegExp(`${start}${e}${end}`, 'iu');
  });
  const hits = [];
  scrubbed.split(/\r?\n/).forEach((line, i) => {
    patterns.forEach((p, term) => { if (p.test(line)) hits.push({ line: i + 1, term }); });
  });
  return hits;
}

/** Secret shapes in text: [{ line, name }]. */
export function findSecretShapes(text) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const s of SECRET_SHAPES) if (s.re.test(line)) hits.push({ line: i + 1, name: s.name });
  });
  return hits;
}

/** Shows enough of a term to recognize it without printing a secret in full. */
export function maskTerm(term) {
  return term.length <= 4 ? `${term[0]}***` : `${term.slice(0, 2)}***${term.slice(-1)} (${term.length} chars)`;
}

/** Values from a .env file (comments and app options skipped). */
export function envValues(text) {
  return text.split(/\r?\n/)
    .map((l) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l))
    .filter((m) => m && !nonSecretKey(m[1]))
    .map((m) => m[2].trim().replace(/^(['"])(.*)\1$/, '$2'))
    .filter((v) => v && v.length >= ENV_MIN_LENGTH);
}

/** The owner's terms file: { terms, allowTerms } ("allow: x" lines are allow terms; # comments and blank lines skipped). */
export function termsFile(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return {
    terms: lines.filter((l) => !/^allow:/i.test(l)),
    allowTerms: lines.filter((l) => /^allow:/i.test(l)).map((l) => l.replace(/^allow:\s*/i, '')).filter(Boolean),
  };
}

/** Paths that must never be committed (the hard rules): data/, .env files, health exports, keys, tokens, backups. */
export function isForbiddenPath(file) {
  const f = file.replace(/\\/g, '/');
  return f.startsWith('data/') || /(^|\/)\.env(\..*)?$/.test(f) || /\.(csv|xml|pem|hrbk)$/i.test(f)
    || /(^|\/)(token[^/]*|client_secret[^/]*)\.json$/i.test(f);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function git(args) {
  return execFileSync('git', args, { cwd: repoPath(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function main() {
  const all = process.argv.includes('--all');
  const envPath = repoPath('.env');
  const termsPath = repoPath('data', 'private-terms.txt');
  const own = existsSync(termsPath) ? termsFile(readFileSync(termsPath, 'utf8')) : { terms: [], allowTerms: [] };
  const terms = [...own.terms, ...(existsSync(envPath) ? envValues(readFileSync(envPath, 'utf8')) : [])].filter((t) => t && t.trim());
  const files = (all ? git(['ls-files']) : git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])).split('\n').filter(Boolean);

  // Personal locations must never be committed, even if .gitignore is ever broken.
  const forbidden = files.filter(isForbiddenPath);
  for (const file of forbidden) console.error(`  ${file}  is a personal-data or secret location and must never be committed`);

  let found = forbidden.length;
  for (const file of files) {
    let text;
    try {
      text = all ? readFileSync(repoPath(file), 'utf8') : git(['show', `:${file}`]);
    } catch {
      continue; // deleted in the working tree, or unreadable
    }
    if (text.includes('\u0000')) continue; // binary
    for (const hit of findSecretShapes(text)) {
      found += 1;
      console.error(`  ${file}:${hit.line}  looks like a ${hit.name}`);
    }
    for (const hit of findPersonalHits(text, terms, own.allowTerms)) {
      found += 1;
      console.error(`  ${file}:${hit.line}  matches private term ${maskTerm(terms[hit.term])}`);
    }
  }

  const scope = all ? 'tracked files' : 'staged files';
  if (found) {
    console.error(`check-personal: ${found} problem(s) in ${scope}. Move the value into .env or data/ and use a placeholder.`);
    return 1;
  }
  const local = terms.length ? `${terms.length} private terms` : 'no private terms (no .env or data/private-terms.txt here)';
  console.log(`check-personal: ${files.length} ${scope} checked for secrets and ${local}; nothing found.`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
