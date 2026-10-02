// Public API of the front-matter engine (P1.1).
//
// The raw text is the source of truth: every helper round-trips unrecognised content
// untouched, and saveDocument() returns the original string when nothing changed.

import { splitDocument, joinDocument, hasUnterminatedFrontMatter } from './split.js';
import { parseFrontMatter, readEntryValue, readValues } from './parse.js';
import { appendFrontMatterKeys, patchFrontMatter, formatScalar, formatString, isKeyName, detectListIndent } from './patch.js';
import { applyFieldEdits, describeFields, missingFields, FIELD_CATALOG, MAX_NESTED_DEPTH } from './fields.js';
import { compareFrontMatter } from './compare.js';
import { MANAGED_KEYS } from './keys.js';

export function readDocument(text) {
  const { hasFrontMatter, delimiter, frontMatterRaw, separator, bodyRaw } = splitDocument(text);
  const frontMatter = parseFrontMatter(frontMatterRaw);
  return {
    hasFrontMatter,
    delimiter,
    frontMatterRaw,
    separator,
    bodyRaw,
    frontMatter,
    values: readValues(frontMatter, MANAGED_KEYS),
  };
}

export function saveDocument(originalText, changes = {}, body) {
  const { hasFrontMatter, frontMatterRaw, separator, bodyRaw } = splitDocument(originalText);
  if (!hasFrontMatter) return originalText;

  const patched = patchFrontMatter(frontMatterRaw, changes);
  const nextBody = body === undefined ? bodyRaw : body;
  if (patched === frontMatterRaw && nextBody === bodyRaw) return originalText;
  return joinDocument({ frontMatterRaw: patched, separator, bodyRaw: nextBody });
}

export {
  splitDocument,
  joinDocument,
  hasUnterminatedFrontMatter,
  parseFrontMatter,
  readEntryValue,
  readValues,
  patchFrontMatter,
  appendFrontMatterKeys,
  formatScalar,
  formatString,
  isKeyName,
  detectListIndent,
  compareFrontMatter,
  applyFieldEdits,
  describeFields,
  missingFields,
  FIELD_CATALOG,
  MAX_NESTED_DEPTH,
  MANAGED_KEYS,
};
