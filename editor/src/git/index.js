// The git layer's public surface. Like src/build, this layer owns a process boundary, so it
// is the only other place allowed to spawn one (see test/architecture.test.js).

export {
  ALLOWED_SUBCOMMANDS,
  GitCommandError,
  GitError,
  GitNotARepositoryError,
  GitPushError,
  GitUnknownCommitError,
  GitUnavailableError,
  GitValidationError,
  assertCommitMessage,
  assertSitePath,
  classifyPushFailure,
  classifyRepositoryFailure,
  classifyStatus,
  createGitService,
  parseNumstat,
  parsePushPorcelain,
  parseStatus,
  parseUpstream,
  redactCredentials,
} from './gitService.js';
