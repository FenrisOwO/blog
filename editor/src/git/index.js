// The git layer's public surface. Like src/build, this layer owns a process boundary, so it
// is the only other place allowed to spawn one (see test/architecture.test.js).

export {
  ALLOWED_SUBCOMMANDS,
  GitCommandError,
  GitError,
  GitNotARepositoryError,
  GitUnavailableError,
  GitValidationError,
  assertCommitMessage,
  assertSitePath,
  classifyStatus,
  createGitService,
  parseNumstat,
  parseStatus,
} from './gitService.js';
