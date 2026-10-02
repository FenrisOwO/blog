// Git, as a service - not as a second editor.
//
// The editor's own write path never goes through git: a save writes the file, and git notices
// afterwards. This module reads the repository (status, diff, log, show, remote) and performs
// exactly two writes: a commit of the paths the user ticked, and a push of the current branch to
// a remote that already exists. Every call goes through `execFile` with an argument array - never
// a shell string - so a path containing spaces, quotes, Unicode or a `;` is data, not syntax.
//
// Deliberate limits, because this is a site editor's git panel and not a git client:
//
//   * no `reset`, `clean`, `checkout`, `restore`, `stash`, `fetch`, `pull`, `merge`, `rebase`,
//     `gc`, `init`, `--amend`, `--force`, `--delete`; the allow-list below is the whole surface
//     and anything else throws;
//   * a push never fetches and never forces. A branch that moved on the remote is a *reported*
//     refusal, not something this service resolves by rewriting anything - so no code path here
//     can discard work, local or remote;
//   * **the editor never accepts a credential.** There is no token parameter anywhere in this
//     file: `GIT_TERMINAL_PROMPT=0` makes git use whatever the machine already has (a credential
//     helper, an SSH agent) or fail at once with a message the user can act on. Everything git
//     prints is scrubbed of `scheme://user:password@` before it leaves this module
//     (`redactCredentials`), because the panel renders it in a browser;
//   * no hooks (`--no-verify`) on either write: a commit or a push must not become a way to run
//     arbitrary scripts;
//   * `GIT_OPTIONAL_LOCKS=0` and `GIT_TERMINAL_PROMPT=0`: reading status must not take a lock,
//     and nothing may block on a credential prompt;
//   * an uninitialised repository is reported as `repository: null`, never `git init`-ed.

import { execFile } from 'node:child_process';
import { relative, resolve, sep } from 'node:path';

export class GitError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }
}

export class GitUnavailableError extends GitError {}
export class GitNotARepositoryError extends GitError {}
export class GitValidationError extends GitError {}
export class GitCommandError extends GitError {
  constructor(message, details = {}) {
    super(message, details);
    this.args = details.args ?? [];
    this.code = details.code ?? null;
    this.stderr = details.stderr ?? '';
  }
}
// A reference the history used to hold. Not a crash and not a validation problem: the panel was
// looking at a list that has since been rewritten (a rebase outside the editor, a fetch).
export class GitUnknownCommitError extends GitCommandError {}

// A push git refused. Not a crash either: "no remote is configured", "this machine has no
// credentials" and "the remote has commits you do not have" are states the user resolves outside
// the editor, so a classified `reason` travels with the error. The wording the user reads lives in
// the UI (web/gitView.js) - the same split `classifyRepositoryFailure` already uses.
export class GitPushError extends GitCommandError {
  constructor(message, details = {}) {
    super(message, details);
    this.reason = details.reason ?? 'unknown';
  }
}

// Everything this service is allowed to ask git to do: reading, plus exactly two writes - a commit
// and a push. `remote` and `rev-list` are here for the push panel: which remotes exist, what the
// branch tracks, and how far ahead or behind that tracking ref is.
export const ALLOWED_SUBCOMMANDS = Object.freeze([
  'rev-parse',
  'rev-list',
  'status',
  'diff',
  'log',
  'show',
  'remote',
  'add',
  'commit',
  'push',
  'branch',
  'config',
  'symbolic-ref',
  'version',
]);

const MAX_MESSAGE_LENGTH = 4000;

function normalizeRelPath(path) {
  return String(path).split(sep).join('/');
}

export function assertSitePath(relPath) {
  if (typeof relPath !== 'string' || relPath.trim() === '') {
    throw new GitValidationError('path is required');
  }
  if (relPath.includes('\0')) throw new GitValidationError('path contains a NUL byte');
  if (relPath.startsWith('/') || /^[A-Za-z]:/.test(relPath)) {
    throw new GitValidationError(`path must be relative to the site root: ${relPath}`);
  }
  if (relPath.startsWith('-')) throw new GitValidationError(`path must not start with "-": ${relPath}`);
  const parts = relPath.split(/[\\/]/);
  if (parts.includes('..')) throw new GitValidationError(`path must not escape the site root: ${relPath}`);
  return parts.filter((part) => part !== '' && part !== '.').join('/');
}

export function assertCommitMessage(message) {
  if (typeof message !== 'string' || message.trim() === '') {
    throw new GitValidationError('a commit needs a message');
  }
  if (message.includes('\0')) throw new GitValidationError('the commit message contains a NUL byte');
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new GitValidationError(`the commit message is longer than ${MAX_MESSAGE_LENGTH} characters`);
  }
  return message;
}

// `XY path` records, NUL separated; a rename or a copy carries the original path in the next
// NUL-terminated field. Nothing here splits on whitespace: a path may contain spaces, and with
// `-z` git does not quote anything.
export function parseStatus(output) {
  const fields = String(output).split('\0');
  const entries = [];
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (!record || record.length < 3) continue;
    const staged = record[0];
    const worktree = record[1];
    const path = record.slice(3);
    if (staged === '!' && worktree === '!') continue; // ignored
    let originalPath = null;
    if (staged === 'R' || staged === 'C' || worktree === 'R' || worktree === 'C') {
      originalPath = fields[index + 1] ?? null;
      index += 1;
    }
    entries.push({ index: staged, worktree, path, originalPath });
  }
  return entries;
}

export function classifyStatus({ index, worktree }) {
  const codes = [index, worktree];
  const has = (code) => codes.includes(code);
  if (index === '?' && worktree === '?') return 'untracked';
  if (has('U') || (index === 'A' && worktree === 'A') || (index === 'D' && worktree === 'D')) return 'conflicted';
  if (has('R')) return 'renamed';
  if (has('C')) return 'copied';
  if (has('D')) return 'deleted';
  if (has('A')) return 'added';
  if (has('M')) return 'modified';
  if (has('T')) return 'typechange';
  return 'modified';
}

export function parseNumstat(output) {
  const result = { additions: 0, deletions: 0, binary: false, files: [] };
  for (const line of String(output).split('\n')) {
    if (line.trim() === '') continue;
    const [added, removed, ...rest] = line.split('\t');
    const path = rest.join('\t');
    const binary = added === '-' || removed === '-';
    const additions = binary ? 0 : Number.parseInt(added, 10) || 0;
    const deletions = binary ? 0 : Number.parseInt(removed, 10) || 0;
    if (binary) result.binary = true;
    result.additions += additions;
    result.deletions += deletions;
    result.files.push({ path, binary, additions, deletions });
  }
  return result;
}

// Why `rev-parse` could not answer. Git says "not a git repository" and "dubious ownership"
// in the same tone, but they need opposite advice: one means "no repository here", the other
// means "there is one, and this user is not allowed to read it". Classifying is all this does -
// the wording the user sees belongs to the UI.
export function classifyRepositoryFailure(reason) {
  const text = String(reason ?? '');
  if (/dubious ownership/i.test(text)) {
    const match = /repository at '([^']+)'/.exec(text);
    return { code: 'dubious-ownership', directory: match ? match[1] : null };
  }
  if (/not a git repository/i.test(text)) return { code: 'not-a-repository', directory: null };
  if (/no such file or directory|not found|ENOENT/i.test(text)) return { code: 'git-missing', directory: null };
  return { code: 'unknown', directory: null };
}

// A remote URL can carry a credential, and this service returns remote URLs to a browser. Git
// prints `https://user:token@host/path` for an authenticated remote, so every string that leaves
// this module through a push path goes through here first.
//
// The whole userinfo is dropped, not just the password: `https://<token>@host` (a token used as
// the username) is common on GitHub, and keeping the username in an `git@host:path` ssh remote
// would be the only thing left that says who authenticates. The ssh form carries no secret and is
// left alone on purpose - rewriting it would mangle ordinary text this also runs over.
export function redactCredentials(text) {
  return String(text ?? '').replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s@]+@/g, '$1');
}

// Why a push failed, in git's own words, classified in one place so the UI can give advice that
// matches the cause. Order matters: a rejection is checked before the messages that accompany it
// ("remote: ... Could not read from remote repository").
export function classifyPushFailure(text) {
  const output = String(text ?? '');
  if (/\[rejected\][^\n]*non-fast-forward|non-fast-forward|fetch first|Updates were rejected/i.test(output)) {
    return 'rejected-non-fast-forward';
  }
  if (/protected branch|pre-receive hook declined|\[remote rejected\]|remote rejected|cannot lock ref/i.test(output)) {
    return 'rejected-by-remote';
  }
  if (
    /could not read Username|could not read Password|Authentication failed|Permission denied \(publickey\)|terminal prompts disabled|fatal: Authentication/i.test(
      output,
    )
  ) {
    return 'no-credentials';
  }
  // Checked before the "Could not read from remote repository" wording below, because git adds that
  // line to a connection failure too - and "the network is down" and "the repo is not there" need
  // different advice.
  if (
    /Could not resolve host|unable to access|Failed to connect|Connection (timed out|refused|reset)|Network is unreachable|Temporary failure in name resolution|Operation timed out/i.test(
      output,
    )
  ) {
    return 'network';
  }
  // GitHub answers "Repository not found" both for a private repository this machine cannot read
  // and for a URL that points nowhere; git adds "Could not read from remote repository" to both.
  if (
    /Repository not found|Could not read from remote repository|does not appear to be a git repository|correct access rights/i.test(
      output,
    )
  ) {
    return 'remote-unreadable';
  }
  if (/no configured push destination|No such remote|no remote/i.test(output)) return 'no-remote';
  return 'unknown';
}

// `git rev-parse --abbrev-ref --symbolic-full-name @{upstream}` answers `origin/main`. A branch name
// may itself contain a slash, so only the first segment is the remote. An empty answer (or the
// literal query back) means the branch tracks nothing yet.
export function parseUpstream(fullName) {
  const text = String(fullName ?? '').trim();
  if (text === '' || text === '@{upstream}') return null;
  const slash = text.indexOf('/');
  if (slash <= 0 || slash === text.length - 1) return null;
  return { remote: text.slice(0, slash), branch: text.slice(slash + 1), full: text };
}

// `git push --porcelain` prints one line per ref - `<flag>\t<from>:<to>\t<summary>`, then `Done`.
// The flag is what says whether anything moved: `=` is up to date, `!` was rejected, `*` is a new
// branch. Parsing this (rather than trusting the exit code alone) is what lets the panel tell
// "everything is already there" apart from "the remote refused this ref".
export function parsePushPorcelain(output) {
  const result = { refs: [], upToDate: false, rejected: false, pushed: false, target: null };
  for (const raw of String(output ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('To ')) {
      result.target = redactCredentials(line.slice(3).trim());
      continue;
    }
    const match = /^([ =+*!-])\t([^\t]+)\t(.*)$/.exec(line);
    if (!match) continue;
    const [, flag, refs, summary] = match;
    const [from, to] = refs.split(':');
    result.refs.push({ flag, from, to, summary });
    if (flag === '=') result.upToDate = true;
    else if (flag === '!') result.rejected = true;
    else result.pushed = true;
  }
  return result;
}

export function createGitService({
  siteRoot,
  gitBin = 'git',
  timeoutMs = 15_000,
  // A push talks to another machine: it gets its own budget, and it is the only call here that is
  // allowed to take longer than the local reads.
  pushTimeoutMs = 120_000,
  maxBuffer = 16 * 1024 * 1024,
  cacheMs = 5_000,
  runner = null,
} = {}) {
  if (!siteRoot) throw new GitValidationError('siteRoot is required');
  const root = resolve(siteRoot);
  let cached = null;
  let cachedAt = 0;

  function run(args, { cwd = root, allowFailure = false, timeoutMs: callTimeoutMs = timeoutMs } = {}) {
    const subcommand = args[0];
    if (!ALLOWED_SUBCOMMANDS.includes(subcommand)) {
      return Promise.reject(new GitValidationError(`git ${subcommand} is not allowed by the git service`));
    }
    if (runner) return Promise.resolve(runner(args, { cwd }));

    return new Promise((resolvePromise, reject) => {
      execFile(
        gitBin,
        ['--no-optional-locks', ...args],
        {
          cwd,
          timeout: callTimeoutMs,
          maxBuffer,
          windowsHide: true,
          encoding: 'utf8',
          env: {
            ...process.env,
            GIT_PAGER: 'cat',
            GIT_TERMINAL_PROMPT: '0',
            GIT_OPTIONAL_LOCKS: '0',
            LC_ALL: 'C',
          },
        },
        (error, stdout, stderr) => {
          if (error && error.code === 'ENOENT') {
            reject(new GitUnavailableError(`git is not installed (${gitBin})`));
            return;
          }
          // Exit code 1 means "differences found" for `diff` and "no match" for some probes;
          // the callers that care pass allowFailure and read the output themselves.
          if (error && !allowFailure && error.code !== 1) {
            reject(
              new GitCommandError(`git ${args[0]} failed`, {
                args,
                code: error.code ?? null,
                stderr: String(stderr ?? '').trim().slice(0, 2000),
              }),
            );
            return;
          }
          resolvePromise({
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            code: error ? (error.code ?? 1) : 0,
          });
        },
      );
    });
  }

  async function detectRepository({ force = false } = {}) {
    const now = Date.now();
    if (!force && cached && now - cachedAt < cacheMs) return cached;

    const probe = await run(['rev-parse', '--show-toplevel', '--absolute-git-dir'], { allowFailure: true });
    if (probe.code !== 0 || probe.stdout.trim() === '') {
      const reason = probe.stderr.trim() || 'not a git repository';
      const classified = classifyRepositoryFailure(reason);
      cached = {
        repository: null,
        reason,
        reasonCode: classified.code,
        reasonDirectory: classified.directory,
      };
      cachedAt = now;
      return cached;
    }
    const [repoRoot, gitDir] = probe.stdout.trim().split('\n');
    const branchProbe = await run(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true });
    const headProbe = await run(['rev-parse', '--short', 'HEAD'], { allowFailure: true });
    let branch = branchProbe.code === 0 ? branchProbe.stdout.trim() : '';
    // A repository with no commits yet has an unborn HEAD: `rev-parse` answers "HEAD", and the
    // branch the first commit will land on is the symbolic ref.
    if (branch === 'HEAD' || branch === '') {
      const symbolic = await run(['symbolic-ref', '--short', 'HEAD'], { allowFailure: true });
      if (symbolic.code === 0 && symbolic.stdout.trim() !== '') branch = symbolic.stdout.trim();
    }

    cached = {
      repository: {
        root: repoRoot,
        gitDir: gitDir ?? null,
        // Git is always told repository-relative paths; the UI always shows site-relative ones,
        // because the site may live inside a larger repository.
        prefix: normalizeRelPath(relative(repoRoot, root) || ''),
        branch: branch === '' || branch === 'HEAD' ? null : branch,
        detached: branch === 'HEAD',
        head: headProbe.code === 0 ? headProbe.stdout.trim() : null,
      },
      reason: null,
      reasonCode: null,
      reasonDirectory: null,
    };
    cachedAt = now;
    return cached;
  }

  async function requireRepository({ force = false } = {}) {
    const { repository } = await detectRepository({ force });
    if (!repository) {
      throw new GitNotARepositoryError('this site is not a git repository (the editor will not run git init)');
    }
    return repository;
  }

  // Arguments are always site-relative, because git is spawned with the site root as its
  // working directory. Only what git *prints* is repository-relative.
  function toArgPath(sitePath) {
    return assertSitePath(sitePath);
  }

  function toSitePath(repository, repoPath) {
    const normalized = normalizeRelPath(repoPath);
    if (!repository.prefix) return normalized;
    const prefix = `${repository.prefix}/`;
    return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : null;
  }

  async function status({ paths = null } = {}) {
    const { repository, reason, reasonCode, reasonDirectory } = await detectRepository();
    if (!repository) {
      return {
        repository: null,
        reason,
        reasonCode,
        reasonDirectory,
        branch: null,
        head: null,
        clean: true,
        changes: [],
        counts: { total: 0, staged: 0, unstaged: 0 },
      };
    }

    const args = ['status', '--porcelain=v1', '-z', '--untracked-files=all'];
    const scoped = (paths ?? []).map((path) => toArgPath(path));
    if (scoped.length > 0) args.push('--', ...scoped);
    // No explicit paths: scope to the site, not to the repository it happens to live in.
    else args.push('--', '.');

    const { stdout } = await run(args);
    const changes = [];
    for (const entry of parseStatus(stdout)) {
      const path = toSitePath(repository, entry.path);
      if (path === null) continue; // outside the site: not this editor's business
      changes.push({
        path,
        kind: classifyStatus(entry),
        index: entry.index,
        worktree: entry.worktree,
        // The two halves of `XY`: the index (what a commit would take *now*) and the worktree
        // (what the editor still has to stage). A file can be both, or only one.
        staged: entry.index !== ' ' && entry.index !== '?',
        unstaged: entry.worktree !== ' ' && entry.worktree !== '?',
        originalPath: entry.originalPath ? toSitePath(repository, entry.originalPath) : null,
      });
    }
    changes.sort((a, b) => a.path.localeCompare(b.path));

    const counts = {
      modified: 0,
      added: 0,
      deleted: 0,
      renamed: 0,
      copied: 0,
      untracked: 0,
      conflicted: 0,
      typechange: 0,
    };
    for (const change of changes) counts[change.kind] = (counts[change.kind] ?? 0) + 1;

    return {
      repository,
      reason: null,
      reasonCode: null,
      reasonDirectory: null,
      branch: repository.branch,
      head: repository.head,
      clean: changes.length === 0,
      changes,
      counts: {
        ...counts,
        // Staged against unstaged is a different question from which kind of change it is:
        // one file can be both, which is why these are counted separately from the kinds.
        staged: changes.filter((change) => change.staged).length,
        unstaged: changes.filter((change) => change.unstaged).length,
        total: changes.length,
      },
    };
  }

  async function diff({ path = null, staged = false, context = 3 } = {}) {
    const repository = await requireRepository();
    const common = ['diff', '--no-color', '--no-ext-diff', '--no-textconv'];
    const pathspec = ['--', path ? toArgPath(path) : '.'];
    const stagedFlag = staged ? ['--cached'] : [];
    const range = `-U${Math.max(0, Math.min(Number(context) || 3, 50))}`;

    // An untracked file has no diff yet: show its content as one addition block, which is what
    // "what am I about to add" means to the user.
    if (path) {
      const sitePath = assertSitePath(path);
      const fileStatus = await status({ paths: [sitePath] });
      const change = fileStatus.changes.find((entry) => entry.path === sitePath);
      if (!staged && change?.kind === 'untracked') {
        const text = await run(
          ['diff', '--no-color', '--no-ext-diff', '--no-index', '--', '/dev/null', toArgPath(sitePath)],
          { allowFailure: true },
        );
        return {
          repository,
          path: sitePath,
          kind: 'untracked',
          staged: false,
          binary: false,
          additions: text.stdout.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
          deletions: 0,
          numstat: { additions: 0, deletions: 0, binary: false, files: [] },
          text: text.stdout,
          hunks: 0,
        };
      }
    }

    const numstat = await run([...common, '--numstat', ...stagedFlag, ...pathspec], { allowFailure: true });
    const parsed = parseNumstat(numstat.stdout);
    const { stdout } = await run([...common, range, ...stagedFlag, ...pathspec], { allowFailure: true });

    return {
      repository,
      path: path ? assertSitePath(path) : null,
      kind: null,
      staged,
      binary: parsed.binary,
      additions: parsed.additions,
      deletions: parsed.deletions,
      numstat: parsed,
      text: parsed.binary ? '' : stdout,
      hunks: (stdout.match(/^@@ /gm) ?? []).length,
    };
  }

  async function log({ limit = 30, path = null } = {}) {
    const repository = await requireRepository();
    const count = Math.max(1, Math.min(Number(limit) || 30, 200));
    const args = [
      'log',
      '--no-color',
      `-n${count}`,
      '--date=iso-strict',
      '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e',
    ];
    if (path) args.push('--', toArgPath(path));

    const { stdout, code } = await run(args, { allowFailure: true });
    if (code !== 0) return { repository, commits: [], empty: true };

    const commits = stdout
      .split('\x1e')
      .map((record) => record.replace(/^\n+/, '').trim())
      .filter((record) => record !== '')
      .map((record) => {
        const [sha, author, email, date, subject] = record.split('\x1f');
        return { sha, author, email, date, subject };
      });

    return { repository, commits, empty: commits.length === 0 };
  }

  async function show({ sha, path = null } = {}) {
    const repository = await requireRepository();
    if (typeof sha !== 'string' || !/^[0-9a-fA-F^~][0-9a-fA-F^~.\-/]{0,100}$/.test(sha)) {
      throw new GitValidationError(`not a commit reference: ${sha}`);
    }
    const meta = await run(
      ['show', '--no-color', '--no-patch', '--date=iso-strict', '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1e', sha],
      { allowFailure: true },
    );
    if (meta.code !== 0) {
      throw new GitUnknownCommitError(`unknown commit: ${sha}`, { args: ['show', sha], stderr: meta.stderr.trim() });
    }

    const [commitSha, author, email, date, subject, body] = meta.stdout.split('\x1f');
    const stats = await run(['show', '--no-color', '--numstat', '--format=', sha], { allowFailure: true });
    const parsed = parseNumstat(stats.stdout);

    // With no path this is the whole commit, which is what clicking a history row means; with a
    // path the panel is narrowing to one file. Either way git produces the patch - nothing here
    // compares file contents itself.
    const patchArgs = path
      ? ['show', '--no-color', '--format=', sha, '--', toArgPath(path)]
      : ['show', '--no-color', '--format=', sha];
    const patch = await run(patchArgs, { allowFailure: true });

    return {
      repository,
      commit: {
        sha: commitSha.trim(),
        author,
        email,
        date,
        subject,
        body: (body ?? '').replaceAll('\x1e', '').trim(),
      },
      // A commit can also touch files outside the site (the repository may be larger than the
      // site): those keep their repository-relative path, are marked `outside`, and the UI shows
      // them without offering a diff it could never produce from the site root.
      files: parsed.files.map((file) => {
        const sitePath = toSitePath(repository, file.path);
        return {
          ...file,
          path: sitePath,
          repoPath: normalizeRelPath(file.path),
          outside: sitePath === null,
        };
      }),
      binary: parsed.binary,
      additions: parsed.additions,
      deletions: parsed.deletions,
      text: patch.stdout,
    };
  }

  async function commit({ message, paths } = {}) {
    const repository = await requireRepository();
    const cleanMessage = assertCommitMessage(message);
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new GitValidationError('a commit needs at least one file');
    }
    const sitePaths = [...new Set(paths.map((path) => assertSitePath(path)))];
    const gitPaths = sitePaths.map((path) => toArgPath(path));

    // Stage exactly the selected paths, then commit exactly those: something the user did not
    // tick cannot end up in the commit, even if it happened to be staged already.
    await run(['add', '--', ...gitPaths]);
    const result = await run(['commit', '--no-verify', '-m', cleanMessage, '--', ...gitPaths], { allowFailure: true });
    if (result.code !== 0) {
      throw new GitCommandError('git commit failed', {
        args: ['commit'],
        code: result.code,
        stderr: `${result.stdout}\n${result.stderr}`.trim().slice(0, 2000),
      });
    }

    const head = await run(['rev-parse', 'HEAD'], { allowFailure: true });
    cached = null; // HEAD moved: the next question must be answered by the repository
    return {
      repository: { ...repository, head: head.stdout.trim() },
      sha: head.stdout.trim(),
      message: cleanMessage,
      files: sitePaths,
      output: result.stdout.trim(),
    };
  }

  // What a push would do, answered without touching the network: which remotes exist, what the
  // current branch tracks, and how far ahead or behind that tracking ref is.
  //
  // The tracking ref is only as fresh as the last fetch, and this service deliberately never
  // fetches - so these numbers describe what the *local* repository believes. A branch with no
  // upstream reports `ahead: null` rather than a made-up number, because nothing here knows what is
  // on the other side yet.
  async function remoteStatus() {
    // Read fresh rather than cached: a push publishes a named branch, so the branch and the HEAD
    // state must be what they are *now*, not what a status poll saw a few seconds ago - the user may
    // have switched branch in a terminal, and pushing the branch they left would be a surprise.
    const repository = await requireRepository({ force: true });

    const listed = await run(['remote'], { allowFailure: true });
    const names = listed.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((name) => name !== '');
    const remotes = [];
    for (const name of names) {
      const url = await run(['remote', 'get-url', name], { allowFailure: true });
      remotes.push({ name, url: url.code === 0 ? redactCredentials(url.stdout.trim()) : null });
    }

    const upstreamProbe = await run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], {
      allowFailure: true,
    });
    const upstream = upstreamProbe.code === 0 ? parseUpstream(upstreamProbe.stdout) : null;

    let ahead = null;
    let behind = null;
    if (upstream) {
      // `<behind>\t<ahead>`: the left side is what the upstream has and this branch does not.
      const counts = await run(['rev-list', '--left-right', '--count', `${upstream.full}...HEAD`], {
        allowFailure: true,
      });
      if (counts.code === 0) {
        const [behindText, aheadText] = counts.stdout.trim().split(/\s+/);
        const parsedBehind = Number.parseInt(behindText, 10);
        const parsedAhead = Number.parseInt(aheadText, 10);
        if (Number.isInteger(parsedBehind) && Number.isInteger(parsedAhead)) {
          behind = parsedBehind;
          ahead = parsedAhead;
        }
      }
    }

    const available = remotes.map((entry) => entry.name);
    // The remote a push would go to: the one the branch already tracks, else `origin`, else the only
    // one there is. Several remotes and none of them `origin` is not a guess this service gets to
    // make - the panel asks which one, and `push({remote})` answers.
    const remote =
      upstream && available.includes(upstream.remote)
        ? upstream.remote
        : available.includes('origin')
          ? 'origin'
          : available.length === 1
            ? available[0]
            : null;

    return {
      repository,
      branch: repository.branch ?? null,
      detached: repository.detached === true,
      remotes,
      remote,
      upstream,
      hasUpstream: upstream !== null,
      // A first push creates the remote branch and records it as this branch's upstream, which is a
      // local config write (`branch.<name>.remote` / `.merge`). The plan says so before it happens.
      setUpstream: upstream === null,
      ahead,
      behind,
    };
  }

  // The push - the second and last write in this file.
  //
  // Two rules define it: it pushes **the current branch** to a remote that already exists (the name
  // is matched against `git remote`, so nothing shaped like a flag can reach the command line), and
  // it never fetches and never forces. A branch that moved on the remote comes back as a classified
  // refusal for the user to resolve in a terminal - there is no path here that rewrites history or
  // discards anyone's work.
  //
  // `pushPlan` is the same decision without the network: remote, branch, whether the upstream gets
  // recorded, and the exact command. The panel shows it before asking, and `push` below runs the
  // plan's own args - so what the user was shown and what runs cannot drift apart.
  async function pushPlan({ remote = null, setUpstream = null } = {}) {
    const state = await remoteStatus();
    const { repository } = state;

    if (state.detached || !state.branch) {
      throw new GitPushError('a detached HEAD has no branch to push', { reason: 'detached-head', args: ['push'] });
    }
    if (state.remotes.length === 0) {
      throw new GitPushError('this repository has no remote configured', { reason: 'no-remote', args: ['push'] });
    }
    const wanted = remote ?? state.remote;
    const target = state.remotes.find((entry) => entry.name === wanted) ?? null;
    if (!target) {
      const known = state.remotes.map((entry) => entry.name).join(', ');
      throw new GitValidationError(`unknown remote: ${wanted ?? '(none)'} (known remotes: ${known})`);
    }

    const branch = state.branch;
    const withUpstream = setUpstream === null ? !state.hasUpstream : setUpstream === true;
    const args = ['push', '--porcelain', '--no-verify'];
    if (withUpstream) args.push('--set-upstream');
    args.push(target.name, branch);

    return {
      repository,
      branch,
      remote: target,
      // What the local repository believes. `ahead` is null until the branch tracks something,
      // because nothing here fetches and a first push has no known other side.
      ahead: state.ahead,
      behind: state.behind,
      upstream: state.upstream,
      setUpstream: withUpstream,
      remotes: state.remotes,
      // Reading the tracking ref is not fetching it: the panel says so rather than implying the
      // remote was just contacted.
      trackingRefStale: state.hasUpstream,
      args,
      command: ['git', ...args].join(' '),
    };
  }

  async function push({ remote = null, setUpstream = null } = {}) {
    const plan = await pushPlan({ remote, setUpstream });

    const result = await run(plan.args, { allowFailure: true, timeoutMs: pushTimeoutMs });
    const output = redactCredentials(`${result.stdout}\n${result.stderr}`.trim());
    if (result.code !== 0) {
      throw new GitPushError(`git push ${plan.remote.name} ${plan.branch} failed`, {
        reason: classifyPushFailure(output),
        args: plan.args,
        code: result.code,
        stderr: output.slice(0, 2000),
      });
    }

    const parsed = parsePushPorcelain(result.stdout);
    // The upstream may be new and the ahead count certainly moved: what was cached about the
    // repository is stale the moment a push succeeds.
    cached = null;

    return {
      repository: plan.repository,
      remote: plan.remote.name,
      remoteUrl: plan.remote.url,
      branch: plan.branch,
      upstream: { remote: plan.remote.name, branch: plan.branch, full: `${plan.remote.name}/${plan.branch}` },
      setUpstream: plan.setUpstream,
      pushed: parsed.pushed,
      upToDate: parsed.upToDate && !parsed.pushed,
      rejected: parsed.rejected,
      target: parsed.target,
      refs: parsed.refs,
      output: output.slice(0, 4000),
    };
  }

  return { siteRoot: root, detectRepository, status, diff, log, show, commit, remoteStatus, pushPlan, push, run };
}
