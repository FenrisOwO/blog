// Turn Hugo's console output into something a UI can show.
//
// Written against output captured from the real Hugo 0.167.0 in this project, not
// against documentation. The shapes that matter:
//
//   ERROR error building site: assemble: failed to create page from pageMetaSource /post/x:
//         "/abs/content/post/x/index.md:4:7": [3:7] sequence end token ']' not found
//      1 | title: "x"
//   >  3 | tags: [unclosed
//              ^
//   ERROR the "date" front matter field is not a parsable date: see /abs/content/post/z/index.md
//   WARN  Taxonomy tags not found
//
// Hugo stops at the first fatal error, so typically one diagnostic carries the answer
// and the rest are warnings.

import { isAbsolute, relative, sep } from 'node:path';

const LEVELS = { ERROR: 'error', WARN: 'warning', WARNING: 'warning', INFO: 'info', DEBUG: 'debug' };
const LEVEL_LINE = /^(ERROR|WARN|WARNING|INFO|DEBUG)\s+(.*)$/;
const CODE_FRAME = /^\s*(?:>?\s*\d+\s*\||\s*\^+\s*$)/;
const FILE_EXT = 'md|markdown|toml|ya?ml|html?|json|css|scss|sass|js|mjs|ts|svg|png|jpe?g|gif|webp|txt';
const FILE_EXT_PATTERN = new RegExp(`\\.(?:${FILE_EXT})$`);
// Hugo's real shape puts the position INSIDE the quotes: "…/index.md:8:1"
const QUOTED_WITH_POS = /"([^"]+?):(\d+):(\d+)"/;
const QUOTED_ANY = /"([^"]+)"/g;
const AFTER_QUOTE_POS = /^"([^"]+)":(\d+):(\d+)/;
const BARE_WITH_POS = new RegExp(`([^\\s"'()\\[\\]]+\\.(?:${FILE_EXT})):(\\d+):(\\d+)`);
const BARE_PATH = new RegExp(`([^\\s"'()\\[\\]]+\\.(?:${FILE_EXT}))`);


// Where a diagnostic points, in terms the user recognises.
//
// Hugo reports absolute paths. It usually builds a mirror of the site rather than the site
// itself (see sourceMirror.js), so those paths name the mirror; the editor shows content/
// post/... either way. Paths that are already relative are left alone.
function toSiteRelative(file, siteRoot, buildRoot) {
  if (!file) return file;
  if (!isAbsolute(file)) return file.split(sep).join('/');

  for (const root of [buildRoot, siteRoot]) {
    if (!root) continue;
    const rel = relative(root, file);
    if (rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`)) continue;
    return rel.split(sep).join('/');
  }
  return file;
}

export function extractLocation(message, siteRoot, buildRoot = null) {
  // Prefer a quoted token that actually looks like a file: messages also quote
  // identifiers such as `template for shortcode "nosuchshortcode" not found`.
  for (const match of message.matchAll(QUOTED_ANY)) {
    const inner = match[1];
    const positioned = inner.match(/^(.*?):(\d+):(\d+)$/);
    if (positioned) {
      return { file: toSiteRelative(positioned[1], siteRoot, buildRoot), line: Number(positioned[2]), column: Number(positioned[3]) };
    }
    if (FILE_EXT_PATTERN.test(inner)) {
      return { file: toSiteRelative(inner, siteRoot, buildRoot), line: null, column: null };
    }
  }

  const afterQuote = message.match(AFTER_QUOTE_POS);
  if (afterQuote) {
    return { file: toSiteRelative(afterQuote[1], siteRoot, buildRoot), line: Number(afterQuote[2]), column: Number(afterQuote[3]) };
  }
  const bare = message.match(BARE_WITH_POS);
  if (bare) {
    return { file: toSiteRelative(bare[1], siteRoot, buildRoot), line: Number(bare[2]), column: Number(bare[3]) };
  }
  const path = message.match(BARE_PATH);
  if (path) return { file: toSiteRelative(path[1], siteRoot, buildRoot), line: null, column: null };
  return { file: null, line: null, column: null };
}

// Hugo wraps the useful sentence behind its internal stage names; for the UI, prefer the
// tail after the quoted location (e.g. `failed to extract shortcode: ... not found`).
function shorten(message) {
  const match = message.match(QUOTED_WITH_POS);
  if (!match) return message;
  const trimmed = message.slice(match.index + match[0].length).replace(/^:\s*/, '').trim();
  return trimmed.length > 0 ? trimmed : message;
}


export function parseBuildOutput({ stdout = '', stderr = '', siteRoot, buildRoot = null } = {}) {
  const lines = `${stderr}\n${stdout}`.split('\n');
  const diagnostics = [];
  let current = null;

  for (const line of lines) {
    const levelMatch = line.match(LEVEL_LINE);
    if (levelMatch) {
      const message = levelMatch[2].trim();
      const location = extractLocation(message, siteRoot, buildRoot);
      current = {
        level: LEVELS[levelMatch[1]] ?? 'info',
        message,
        shortMessage: shorten(message),
        file: location.file,
        line: location.line,
        column: location.column,
        context: [],
        raw: line,
      };
      diagnostics.push(current);
      continue;
    }

    if (current && line.trim() === '') continue;

    // Code frames belong to the diagnostic above them; anything else indented is a
    // continuation of its message.
    if (current && CODE_FRAME.test(line)) {
      current.context.push(line.replace(/\s+$/, ''));
      continue;
    }
    if (current && /^\s+\S/.test(line)) {
      current.message += `\n${line.trim()}`;
      continue;
    }
    current = null;
  }

  const seen = new Set();
  const deduped = diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.level}|${diagnostic.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const errorCount = deduped.filter((d) => d.level === 'error').length;
  const warningCount = deduped.filter((d) => d.level === 'warning').length;

  return {
    diagnostics: deduped,
    errorCount,
    warningCount,
    firstError: deduped.find((d) => d.level === 'error') ?? null,
  };
}

export function formatDiagnostic(diagnostic) {
  const where = diagnostic.file
    ? `${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}` : ''}${diagnostic.column ? `:${diagnostic.column}` : ''}`
    : '';
  return where ? `${where}: ${diagnostic.shortMessage}` : diagnostic.shortMessage;
}

export function parseBuildStats(stdout = '') {
  const total = stdout.match(/Total in (\d+)\s*ms/);
  return { totalMs: total ? Number(total[1]) : null };
}
