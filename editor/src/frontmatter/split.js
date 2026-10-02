// Lossless split/join of a Markdown document into front matter and body.
//
// The document is modelled as three verbatim slices:
//   frontMatterRaw : from the opening delimiter through the closing delimiter
//   separator      : the newline right after the closing delimiter ('' at EOF)
//   bodyRaw        : everything after that newline
//
// Joining the three reproduces the original bytes exactly, which is what lets the
// raw text stay the single source of truth (P1 acceptance: a no-op save must be
// byte-identical).

const DELIMITERS = ['---', '+++'];

function matchOpener(text) {
  for (const delimiter of DELIMITERS) {
    if (!text.startsWith(delimiter)) continue;
    const rest = text.slice(delimiter.length);
    const match = /^[ \t]*(\r\n|\n|$)/.exec(rest);
    if (match) return { delimiter, contentStart: delimiter.length + match[0].length };
  }
  return null;
}

function findClosingTokenEnd(text, from, delimiter) {
  let lineStart = from;
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    let line = text.slice(lineStart, lineEnd);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    const token = line.trimEnd();
    if (token === delimiter) return lineStart + token.length;
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  return -1;
}

export function splitDocument(text) {
  const opener = matchOpener(text);
  if (opener) {
    const tokenEnd = findClosingTokenEnd(text, opener.contentStart, opener.delimiter);
    if (tokenEnd !== -1) {
      const rest = text.slice(tokenEnd);
      const separatorMatch = /^(\r\n|\n)/.exec(rest);
      const separator = separatorMatch ? separatorMatch[0] : '';
      return {
        hasFrontMatter: true,
        delimiter: opener.delimiter,
        frontMatterRaw: text.slice(0, tokenEnd),
        separator,
        bodyRaw: rest.slice(separator.length),
      };
    }
  }
  return {
    hasFrontMatter: false,
    delimiter: null,
    frontMatterRaw: '',
    separator: '',
    bodyRaw: text,
  };
}

// A document that opens a front matter block and never closes it. Hugo cannot parse this
// ("EOF looking for end YAML front matter delimiter"), and this module's own split sees such
// a document as having no front matter at all - so it is a state a save must never produce.
export function hasUnterminatedFrontMatter(text) {
  const source = String(text ?? '');
  return matchOpener(source) !== null && !splitDocument(source).hasFrontMatter;
}

export function joinDocument({ frontMatterRaw = '', separator = '', bodyRaw = '' } = {}) {
  return frontMatterRaw + separator + bodyRaw;
}
