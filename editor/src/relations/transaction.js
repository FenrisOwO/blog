// A transaction: a ChangeSet that either happens completely or not at all.
//
// Phases 1-6 saved one file at a time, and one file is its own transaction. Phase 7 writes
// many, which introduces the one failure mode that must never reach a user's site:
//
//   a.md 已修改
//   b.md 已修改
//   c.md 写失败        <- and now the site is half-renamed
//
// So every step is prepared and validated before the first byte moves, every modified file is
// copied to the timestamped backup tree first, every deletion goes through the existing trash
// (which is already a reversible move), and every write is read back and compared. Anything
// that fails - a guard refusal, a write error, a read-back mismatch - rolls the applied steps
// back in reverse order and raises a TransactionError that says what happened.
//
// The whole commit is synchronous on purpose. It reuses the write path the rest of the editor
// already uses (atomicWrite / createBackup / trash), and being synchronous it cannot interleave
// with another request's write: Node runs one callback at a time, so a ChangeSet is atomic with
// respect to the editor as well as to the filesystem.

import { existsSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWrite as atomicWriteFile, createBackup as createBackupFile } from '../site/safeWrite.js';
import { moveToTrash, relocate, restoreFromTrash } from '../site/trash.js';

export class TransactionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'TransactionError';
    this.details = details;
  }
}

export class ChangeSetRejectedError extends Error {
  constructor(message, conflicts = []) {
    super(message);
    this.name = 'ChangeSetRejectedError';
    this.conflicts = conflicts;
  }
}

// Resolve a step to absolute paths and refuse it if the guard or the disk says no. Nothing is
// written here: a plan that cannot be executed must fail before the first step runs.
//
// A guard refusal is a refusal, not a crash: it is reported as a ChangeSetRejectedError with the
// guard's own reason, so a caller can hand the whole list to a user (and a server can answer 400
// without leaking whether a path exists).
function prepareSteps({ changeSet, guard }) {
  const prepared = [];
  const resolveWrite = (relPath) => {
    try {
      return guard.resolveForWrite(relPath);
    } catch (error) {
      throw new ChangeSetRejectedError(`不允许写入 ${relPath}：${error.message}`);
    }
  };
  const resolveRemove = (relPath) => {
    try {
      return guard.resolveForRemoval(relPath);
    } catch (error) {
      throw new ChangeSetRejectedError(`不允许删除 ${relPath}：${error.message}`);
    }
  };
  const resolveTermPage = (relPath) => {
    try {
      return guard.resolveTaxonomyWrite(relPath);
    } catch (error) {
      throw new ChangeSetRejectedError(`不允许写入元数据页 ${relPath}：${error.message}`);
    }
  };

  for (const step of changeSet.changes) {
    if (step.kind === 'modify') {
      const abs = resolveWrite(step.relPath);
      if (!existsSync(abs)) throw new ChangeSetRejectedError(`文件不存在：${step.relPath}`);
      prepared.push({ ...step, abs });
      continue;
    }
    if (step.kind === 'create') {
      const abs = resolveWrite(step.relPath);
      if (existsSync(abs)) throw new ChangeSetRejectedError(`目标已存在，拒绝覆盖：${step.relPath}`);
      prepared.push({ ...step, abs });
      continue;
    }
    if (step.kind === 'delete') {
      const abs = resolveRemove(step.relPath);
      if (!existsSync(abs)) throw new ChangeSetRejectedError(`文件不存在：${step.relPath}`);
      prepared.push({ ...step, abs });
      continue;
    }
    if (step.kind === 'move') {
      const taxonomyPage = guard.isWritableTaxonomyPage(step.relPath);
      const movable = taxonomyPage || guard.isWritable(step.relPath);
      if (!movable) throw new ChangeSetRejectedError(`不允许移动的路径：${step.relPath}`);
      const from = taxonomyPage ? resolveTermPage(step.relPath) : resolveWrite(step.relPath);
      if (!existsSync(from)) throw new ChangeSetRejectedError(`文件不存在：${step.relPath}`);

      const destinationIsTermPage = guard.isWritableTaxonomyPage(step.toPath);
      const destinationAllowed = destinationIsTermPage || guard.isWritable(step.toPath);
      if (!destinationAllowed) throw new ChangeSetRejectedError(`目标路径不允许写入：${step.toPath}`);
      const to = destinationIsTermPage ? resolveTermPage(step.toPath) : resolveWrite(step.toPath);
      if (existsSync(to)) throw new ChangeSetRejectedError(`目标已存在，拒绝覆盖：${step.toPath}`);
      prepared.push({ ...step, from, to });
      continue;
    }
    throw new ChangeSetRejectedError(`未知的变更类型：${step.kind}`);
  }

  // A destination equal to another step's source (or vice versa) is a plan that depends on
  // order; refusing it keeps rollback trivially correct.
  const sources = new Set(prepared.filter((step) => step.kind === 'move').map((step) => step.from));
  for (const step of prepared) {
    const destination = step.kind === 'move' ? step.to : step.abs;
    if (sources.has(destination)) {
      throw new ChangeSetRejectedError(`目标与另一步的源路径相同，拒绝执行：${destination}`);
    }
  }

  return prepared;
}

export function createTransaction({ guard, backupRoot, reason = 'changeset', io = {} }) {
  // Every filesystem call goes through one object so a test can inject the two failures that
  // cannot be produced honestly from a test - a write that silently lands wrong, and a write
  // that fails outright - and still run the real rollback path against the real disk.
  const fs = {
    existsSync,
    readFileSync,
    rmSync,
    atomicWrite: atomicWriteFile,
    createBackup: createBackupFile,
    moveToTrash,
    relocate,
    restoreFromTrash,
    ...io,
  };
  const history = [];

  function applyStep(step, applied) {
    if (step.kind === 'modify') {
      const backupPath = fs.createBackup(step.abs, backupRoot, step.relPath);
      applied.push({ kind: 'modify', relPath: step.relPath, abs: step.abs, before: step.before, backupPath });
      fs.atomicWrite(step.abs, step.after);
      return { relPath: step.relPath, kind: 'modify', backupPath };
    }
    if (step.kind === 'create') {
      applied.push({ kind: 'create', relPath: step.relPath, abs: step.abs });
      fs.atomicWrite(step.abs, step.text);
      return { relPath: step.relPath, kind: 'create', backupPath: null };
    }
    if (step.kind === 'move') {
      applied.push({ kind: 'move', relPath: step.relPath, toPath: step.toPath, from: step.from, to: step.to });
      fs.relocate(step.from, step.to);
      return { relPath: step.relPath, kind: 'move', toPath: step.toPath, backupPath: null };
    }
    if (step.kind === 'delete') {
      const entry = fs.moveToTrash({ absPath: step.abs, relPath: step.relPath, backupRoot, reason });
      applied.push({ kind: 'delete', relPath: step.relPath, abs: step.abs, trashId: entry.id });
      return { relPath: step.relPath, kind: 'delete', trashId: entry.id, backupPath: null };
    }
    throw new TransactionError(`未知的变更类型：${step.kind}`);
  }

  // Read every written path back and compare: a write that silently truncated, or a move that
  // landed somewhere else, is a failure like any other and rolls the whole set back.
  function verifyStep(step) {
    if (step.kind === 'modify') {
      const text = fs.readFileSync(step.abs, 'utf8');
      if (text !== step.after) throw new Error(`回读不一致：${step.relPath}`);
      return;
    }
    if (step.kind === 'create') {
      const text = fs.readFileSync(step.abs, 'utf8');
      if (text !== step.text) throw new Error(`回读不一致：${step.relPath}`);
      return;
    }
    if (step.kind === 'move') {
      if (fs.existsSync(step.from)) throw new Error(`移动后源文件仍在：${step.relPath}`);
      const text = fs.readFileSync(step.to, 'utf8');
      if (text !== step.content) throw new Error(`回读不一致：${step.toPath}`);
      return;
    }
    if (step.kind === 'delete') {
      if (fs.existsSync(step.abs)) throw new Error(`删除后文件仍在：${step.relPath}`);
    }
  }

  function rollback(applied) {
    const failures = [];
    for (const entry of [...applied].reverse()) {
      try {
        if (entry.kind === 'modify') fs.atomicWrite(entry.abs, entry.before);
        else if (entry.kind === 'create') fs.rmSync(entry.abs, { force: true });
        else if (entry.kind === 'move') {
          fs.relocate(entry.to, entry.from);
          // Moving back can leave the directory the move created (a new taxonomy term
          // directory) behind; rolling back means the tree is as it was, empty directories
          // included.
          try {
            rmdirSync(dirname(entry.to));
          } catch {
            /* not empty, or never created: nothing to clean up */
          }
        } else if (entry.kind === 'delete') fs.restoreFromTrash({ backupRoot, id: entry.trashId, guard });
      } catch (error) {
        failures.push({ relPath: entry.relPath, kind: entry.kind, error: error.message });
      }
    }
    return failures;
  }

  return {
    // Plan-only: everything the transaction would do, with nothing written. The ChangeSet is
    // already the description; this adds the guard/disk verdict, which is the part a UI must
    // show before it offers a confirm button.
    review(changeSet) {
      const conflicts = [];
      try {
        prepareSteps({ changeSet, guard });
      } catch (error) {
        if (error instanceof ChangeSetRejectedError) return { ok: false, conflicts: [error.message] };
        throw error;
      }
      return { ok: conflicts.length === 0, conflicts };
    },

    commit(changeSet) {
      const prepared = prepareSteps({ changeSet, guard }); // throws before anything is written
      const applied = [];
      const results = [];
      try {
        for (const step of prepared) {
          // A move's expected content is read before the move, so the read-back compares the
          // destination with what the source actually held.
          if (step.kind === 'move') step.content = fs.readFileSync(step.from, 'utf8');
          results.push(applyStep(step, applied));
        }
        for (const step of prepared) verifyStep(step);
      } catch (error) {
        const failures = rollback(applied);
        const message = failures.length === 0
          ? `变更集执行失败，已回滚：${error.message}`
          : `变更集执行失败，且回滚未能完全成功：${error.message}；回滚失败：${failures.map((item) => item.relPath).join(', ')}`;
        const failure = new TransactionError(message, {
          operation: changeSet.operation,
          failedStep: error.step ?? null,
          applied: results,
          rollback: { ok: failures.length === 0, failures },
          cause: error.message,
        });
        throw failure;
      }

      const committed = {
        status: 'committed',
        operation: changeSet.operation,
        applied: results,
        counts: changeSet.counts,
        backupRoot,
      };
      history.push(committed);
      return committed;
    },

    get history() {
      return [...history];
    },
  };
}
