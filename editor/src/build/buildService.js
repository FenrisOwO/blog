// Hugo build orchestration.
//
// Responsibilities, and deliberately nothing else:
//   - run one build at a time (single flight), coalescing bursts into one follow-up
//   - debounce, so a save plus its watcher echo produce one build
//   - build into a staging directory, publish to the real output only on a clean exit
//   - keep the last result, its parsed diagnostics and a short history for the UI
//
// It never touches content files. Source -> staging -> public -> preview stays a
// one-way flow, which is what keeps "why didn't my page change?" answerable.

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { formatDiagnostic, parseBuildOutput, parseBuildStats } from './buildErrors.js';
import { defaultHugoBin, hugoArgs, runCommand } from './command.js';
import { publishDirectory } from './publisher.js';
import { DEFAULT_MIRROR_CONCURRENCY, mirrorSource } from './sourceMirror.js';

const HISTORY_LIMIT = 10;
const DIAGNOSTIC_LIMIT = 50;
const LOG_TAIL_CHARS = 6000;

export const ACTIONS = ['manual', 'save', 'watch', 'startup'];

function tail(text, limit = LOG_TAIL_CHARS) {
  if (!text) return '';
  return text.length <= limit ? text : text.slice(text.length - limit);
}

export function createBuildService(options = {}) {
  const {
    siteRoot,
    // When set, the build reads from a mirror of siteRoot here instead of siteRoot itself.
    // That is the difference between an 8s build and a 1s build on a slow source mount; see
    // sourceMirror.js. Left unset, Hugo reads the site in place.
    sourceBuildDir = null,
    stagingDir,
    cacheDir,
    publishDir = join(siteRoot ?? '.', 'public'),
    // The output directory must live inside this root. Defaults to the site itself, so a
    // misconfigured destination cannot publish (or clean) somewhere unrelated.
    publishRoot = siteRoot,
    hugoBin = defaultHugoBin(),
    timeoutMs = 180_000,
    debounceMs = 700,
    publish = true,
    cleanDestination = false,
    // Phase 6: after a successful build, outputs this publisher wrote earlier whose source is
    // gone (a deleted image) are removed from the output directory. Off unless asked for.
    pruneOutputs = false,
    publishManifest = null,
    publishConcurrency,
    mirrorConcurrency = DEFAULT_MIRROR_CONCURRENCY,
    extraArgs = [],
    runner = runCommand,
    now = () => Date.now(),
  } = options;

  if (!siteRoot) throw new Error('createBuildService requires siteRoot');
  if (!stagingDir) throw new Error('createBuildService requires stagingDir');

  const listeners = new Set();
  const history = [];

  let activity = 'idle'; // idle | queued | running
  let generation = 0;
  let buildNumber = 0;
  let current = null;
  let pendingTrigger = null;
  let debounceTimer = null;
  let lastBuild = null;

  function notify() {
    const status = getStatus();
    for (const listener of listeners) {
      try {
        listener(status);
      } catch {
        // A broken subscriber must not break a build.
      }
    }
  }

  function state() {
    if (activity === 'running') return 'running';
    if (activity === 'queued') return 'queued';
    return lastBuild ? lastBuild.state : 'idle';
  }

  function getStatus() {
    return {
      state: state(),
      activity,
      generation,
      queued: activity === 'queued' || pendingTrigger !== null,
      preview: { url: '/', generation },
      lastBuild,
      history: [...history],
      config: {
        siteRoot,
        sourceBuildDir: sourceBuildDir ?? null,
        stagingDir,
        cacheDir: cacheDir ?? null,
        publishDir,
        publishManifest,
        hugoBin,
        timeoutMs,
        debounceMs,
        publish,
        cleanDestination,
        extraArgs,
      },
    };
  }

  function summarize(record) {
    return {
      buildNumber: record.buildNumber,
      state: record.state,
      trigger: record.trigger,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      durationMs: record.durationMs,
      errorCount: record.errorCount,
      warningCount: record.warningCount,
      message: record.message,
      generation: record.generation,
    };
  }

  function describeFailure(result, parsed, publishError, mirrorError = null) {
    if (mirrorError) return `构建前同步源目录失败: ${mirrorError}`;
    if (result.spawnError) return `无法启动 Hugo: ${result.spawnError}`;
    if (result.timedOut) return `构建超时（超过 ${Math.round(timeoutMs / 1000)} 秒），已终止`;
    if (publishError) return `构建成功但发布失败: ${publishError}`;
    if (parsed.firstError) return formatDiagnostic(parsed.firstError);
    if (result.exitCode !== null && result.exitCode !== 0) return `Hugo 退出码 ${result.exitCode}`;
    return '构建失败';
  }

  async function runOnce(trigger) {
    buildNumber += 1;
    const startedAt = now();
    const buildId = buildNumber;

    activity = 'running';
    notify();

    rmSync(stagingDir, { recursive: true, force: true });
    mkdirSync(stagingDir, { recursive: true });
    if (cacheDir) mkdirSync(cacheDir, { recursive: true });

    // Hugo reads the source tree, so a slow source mount is paid for on every page, template
    // and asset. Mirroring first (in parallel, ~0.6s for this site) is what makes the build
    // fast; failing to mirror is a build failure, never a silent fall back to the slow path.
    const buildRoot = sourceBuildDir ?? siteRoot;
    let mirror = null;
    let mirrorError = null;
    const mirrorStartedAt = now();
    if (sourceBuildDir) {
      try {
        mirror = await mirrorSource({
          from: siteRoot,
          to: sourceBuildDir,
          // The published output and the staging area are not source, and the manifest lives
          // alongside the editor's own build state rather than in the site.
          skip: [publishDir, stagingDir, cacheDir, publishManifest].filter(Boolean),
          concurrency: mirrorConcurrency,
        });
        mirror = { ...mirror, durationMs: now() - mirrorStartedAt };
      } catch (error) {
        mirrorError = error.message;
        mirror = { error: mirrorError, durationMs: now() - mirrorStartedAt };
      }
    }

    const args = hugoArgs({ siteRoot: buildRoot, destination: stagingDir, cacheDir, cleanDestination, extraArgs });

    // A build must never run against a mirror that failed to update: the user would see the
    // previous content and believe it was the new one.
    let result;
    if (mirrorError) {
      result = {
        ok: false,
        exitCode: null,
        timedOut: false,
        spawnError: null,
        stdout: '',
        stderr: '',
        durationMs: now() - startedAt,
        command: `${hugoBin} ${args.join(' ')}`,
      };
    } else {
      try {
        result = await runner({ bin: hugoBin, args, cwd: buildRoot, timeoutMs });
      } catch (error) {
        result = {
          ok: false,
          exitCode: null,
          timedOut: false,
          spawnError: error.message,
          stdout: '',
          stderr: '',
          durationMs: now() - startedAt,
          command: `${hugoBin} ${args.join(' ')}`,
        };
      }
    }

    // Diagnostics name files under the mirror when the build used one; buildRoot maps them
    // back to content/... so the message points at something the user can open.
    const parsed = parseBuildOutput({ stdout: result.stdout, stderr: result.stderr, siteRoot, buildRoot });
    const stats = parseBuildStats(result.stdout ?? '');

    let published = null;
    let publishError = null;
    const publishStartedAt = now();
    if (result.ok && publish) {
      try {
        published = await publishDirectory({
          from: stagingDir,
          to: publishDir,
          allowedRoot: publishRoot,
          clean: cleanDestination,
          prune: pruneOutputs,
          manifest: publishManifest,
          concurrency: publishConcurrency,
        });
      } catch (error) {
        publishError = error.message;
      }
    }

    const succeeded = Boolean(result.ok) && !publishError;
    if (succeeded) generation += 1;

    const finishedAt = now();
    const record = {
      buildNumber: buildId,
      trigger,
      state: succeeded ? 'success' : 'error',
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      hugoDurationMs: result.durationMs ?? null,
      mirror,
      mirrorMs: mirror ? mirror.durationMs ?? null : null,
      publishMs: published ? now() - publishStartedAt : null,
      exitCode: result.exitCode,
      timedOut: Boolean(result.timedOut),
      spawnError: result.spawnError ?? null,
      command: result.command,
      errorCount: parsed.errorCount,
      warningCount: parsed.warningCount,
      diagnostics: parsed.diagnostics.slice(0, DIAGNOSTIC_LIMIT),
      diagnosticsTruncated: parsed.diagnostics.length > DIAGNOSTIC_LIMIT,
      stats,
      published,
      publishError,
      message: succeeded
        ? `构建成功${published ? `，发布 ${published.added + published.updated} 个文件（跳过 ${published.skipped} 个未变化）` : ''}`
        : describeFailure(result, parsed, publishError, mirrorError),
      generation,
      logTail: tail(`${result.stderr ?? ''}${result.stdout ?? ''}`),
    };

    lastBuild = record;
    history.unshift(summarize(record));
    if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;

    activity = 'idle';
    notify();
    return record;
  }

  function build({ trigger = 'manual' } = {}) {
    if (current) {
      // Coalesce: one follow-up is enough no matter how many requests arrive.
      pendingTrigger = pendingTrigger ?? trigger;
      notify();
      return current;
    }

    const promise = runOnce(trigger)
      .catch((error) => {
        lastBuild = {
          buildNumber,
          trigger,
          state: 'error',
          startedAt: now(),
          finishedAt: now(),
          durationMs: 0,
          message: `构建服务内部错误: ${error.message}`,
          errorCount: 1,
          warningCount: 0,
          diagnostics: [{ level: 'error', message: error.message, shortMessage: error.message, file: null, line: null, column: null, context: [] }],
          published: null,
          generation,
          logTail: '',
        };
        return lastBuild;
      })
      .finally(() => {
        current = null;
        activity = 'idle';
        const next = pendingTrigger;
        pendingTrigger = null;
        if (next) {
          debounceTimer = setTimeout(() => {
            debounceTimer = null;
            void build({ trigger: next });
          }, 0);
        }
        notify();
      });

    current = promise;
    return promise;
  }

  function scheduleBuild({ trigger = 'watch', delay = debounceMs } = {}) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void build({ trigger });
    }, delay);
    if (activity === 'idle') activity = 'queued';
    notify();
    return getStatus();
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function waitForIdle() {
    if (!current && !debounceTimer && !pendingTrigger) return Promise.resolve(getStatus());
    return new Promise((resolve) => {
      const unsubscribe = subscribe((status) => {
        if (status.activity === 'idle' && !debounceTimer && !pendingTrigger) {
          unsubscribe();
          resolve(status);
        }
      });
    });
  }

  function stop() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    pendingTrigger = null;
    activity = 'idle';
    listeners.clear();
  }

  return { build, scheduleBuild, getStatus, subscribe, waitForIdle, stop };
}
