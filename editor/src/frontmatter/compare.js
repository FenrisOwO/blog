// Front matter change reporting.
//
// Used by the save preview so the user can see exactly what a save would do before it
// happens - in particular whether any key the editor does not manage is about to
// change. This only reads; it never rewrites anything.

import { MANAGED_KEYS } from './keys.js';
import { parseFrontMatter } from './parse.js';
import { splitDocument } from './split.js';

function entryRaw(frontMatterRaw, entry) {
  return frontMatterRaw.slice(entry.start, entry.end);
}

export function compareFrontMatter(originalText, targetText) {
  const original = splitDocument(originalText);
  const target = splitDocument(targetText);
  const originalParsed = parseFrontMatter(original.frontMatterRaw);
  const targetParsed = parseFrontMatter(target.frontMatterRaw);

  const originalKeys = originalParsed.entries.map((entry) => entry.key);
  const targetKeys = targetParsed.entries.map((entry) => entry.key);

  const addedKeys = targetKeys.filter((key) => !originalKeys.includes(key));
  const removedKeys = originalKeys.filter((key) => !targetKeys.includes(key));

  const changedKeys = [];
  for (const key of originalKeys) {
    const before = originalParsed.byKey.get(key);
    const after = targetParsed.byKey.get(key);
    if (!before || !after) continue;
    if (entryRaw(original.frontMatterRaw, before) !== entryRaw(target.frontMatterRaw, after)) {
      changedKeys.push(key);
    }
  }

  return {
    hasFrontMatter: { original: original.hasFrontMatter, target: target.hasFrontMatter },
    originalKeys,
    targetKeys,
    addedKeys,
    removedKeys,
    changedKeys,
    unknownChangedKeys: changedKeys.filter((key) => !MANAGED_KEYS.includes(key)),
    bodyChanged: original.bodyRaw !== target.bodyRaw,
  };
}
