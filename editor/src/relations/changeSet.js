// A ChangeSet is what a cross-document edit looks like before it happens.
//
// Phase 1-6 wrote one document (or one resource) behind one confirmation. Phase 7 has to be
// able to say "renaming this tag changes these eight files, moves this one, and touches
// nothing else" - and then write exactly that, or nothing at all. So the plan is a first
// class object: a list of steps, a per-step diff, and a summary a user can read without
// opening anything.
//
// This module is pure. It never touches the filesystem, never decides whether a path is
// allowed (that is PathGuard) and never writes (that is the transaction). Its job is to hold
// the intent, prove it internally consistent, and render it.

import { diffLines, formatDiff } from '../site/safeWrite.js';

export class ChangeSetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChangeSetError';
  }
}

export const CHANGE_KINDS = ['modify', 'create', 'delete', 'move'];

function summarizeDiff(diff) {
  return { added: diff.added.length, removed: diff.removed.length, changed: diff.changed };
}

export function createChangeSet({ operation, summary = '', warnings = [] } = {}) {
  if (!operation) throw new ChangeSetError('a change set needs an operation name');

  const steps = [];
  const unchanged = [];
  const notes = [...warnings];

  const api = {
    operation,
    get steps() {
      return [...steps];
    },
    warn(message) {
      notes.push(message);
      return api;
    },
    summary(text) {
      if (text !== undefined) summary = text;
      return summary;
    },
    // A document whose content was computed and turned out to be identical. Recorded rather
    // than dropped, so a plan can say "3 of 11 files already had this tag" instead of
    // pretending it never looked.
    unchanged(entry) {
      unchanged.push(entry);
      return api;
    },
    modify({ relPath, before, after, note = null }) {
      if (typeof before !== 'string' || typeof after !== 'string') {
        throw new ChangeSetError(`modify needs before and after text: ${relPath}`);
      }
      if (before === after) throw new ChangeSetError(`modify of ${relPath} would not change anything; use unchanged()`);
      steps.push({ kind: 'modify', relPath, before, after, note });
      return api;
    },
    create({ relPath, text, note = null }) {
      if (typeof text !== 'string') throw new ChangeSetError(`create needs text: ${relPath}`);
      steps.push({ kind: 'create', relPath, text, note });
      return api;
    },
    // A deletion is always a move into the trash, so the step carries no bytes - only what
    // is being removed.
    delete({ relPath, kind = 'file', files = null, note = null }) {
      steps.push({ kind: 'delete', relPath, targetKind: kind, files, note });
      return api;
    },
    move({ from, to, location = 'content', files = null, note = null }) {
      if (!from || !to) throw new ChangeSetError('move needs from and to');
      if (from === to) throw new ChangeSetError(`move of ${from} onto itself`);
      steps.push({ kind: 'move', relPath: from, toPath: to, location, files, note });
      return api;
    },
    build() {
      const changes = steps.map((step) => {
        if (step.kind === 'modify') {
          const diff = diffLines(step.before, step.after);
          return { ...step, diff: summarizeDiff(diff), diffText: formatDiff(diff, step.relPath) };
        }
        if (step.kind === 'create') {
          const lines = step.text.split('\n');
          return {
            ...step,
            diff: { added: lines.length, removed: 0, changed: lines.length },
            diffText: [`--- ${step.relPath} (new)`, ...lines.map((line) => `+ ${line}`)].join('\n'),
          };
        }
        if (step.kind === 'move') {
          return { ...step, diffText: [`MOVE ${step.relPath}`, `  → ${step.toPath}`].join('\n') };
        }
        return { ...step, diffText: `DELETE ${step.relPath}` };
      });

      const counts = { modify: 0, create: 0, delete: 0, move: 0 };
      for (const step of steps) counts[step.kind] += 1;
      counts.total = steps.length;
      counts.files = steps.reduce((total, step) => total + (step.files ?? 1), 0);

      assertNoConflicts(steps);

      const touched = [];
      for (const step of steps) {
        touched.push(step.relPath);
        if (step.kind === 'move') touched.push(step.toPath);
      }

      const lines = [
        `${operation}：将修改 ${counts.modify} 个文件，新增 ${counts.create} 个，删除 ${counts.delete} 个，移动 ${counts.move} 个`,
      ];
      if (unchanged.length > 0) lines.push(`（${unchanged.length} 个文件已经是目标状态，不写入）`);
      for (const step of changes) {
        if (step.kind === 'move') lines.push(`MOVE ${step.relPath} → ${step.toPath}`);
        else if (step.kind === 'delete') lines.push(`DELETE ${step.relPath}`);
        else lines.push(`${step.kind === 'create' ? 'CREATE' : 'MODIFY'} ${step.relPath}`);
      }

      return {
        operation,
        summary,
        warnings: [...notes],
        counts,
        changes,
        unchanged: [...unchanged],
        touched: [...new Set(touched)],
        noop: counts.total === 0,
        text: lines.join('\n'),
      };
    },
  };

  return api;
}

// Internal consistency, checked here because it needs no disk access: two steps that write the
// same path, or a step that writes a path another step removes, is a plan that cannot be
// executed - and it has to be refused at planning time, not discovered halfway through writing.
function assertNoConflicts(steps) {
  const writers = new Map();
  const removers = new Map();
  const register = (map, path, step) => {
    if (map.has(path)) throw new ChangeSetError(`变更计划冲突：${path} 被多个步骤同时写入或移动`);
    map.set(path, step);
  };

  for (const step of steps) {
    if (step.kind === 'modify' || step.kind === 'create') register(writers, step.relPath, step);
    if (step.kind === 'move') {
      register(writers, step.toPath, step);
      register(removers, step.relPath, step);
    }
    if (step.kind === 'delete') register(removers, step.relPath, step);
  }

  for (const path of writers.keys()) {
    if (removers.has(path)) throw new ChangeSetError(`变更计划冲突：${path} 同时被写入和删除或移动`);
  }
}
