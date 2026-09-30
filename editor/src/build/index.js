// Public surface of the build layer.
//
//   site source  ->  hugo (staging dir)  ->  publish  ->  site/public  ->  preview
//
// Nothing here writes to the content tree, and the staging/cache directories live under
// editor/.build so a build never adds files to the Hugo project itself.

import { tmpdir } from 'node:os';
import { join } from 'node:path';

export { createBuildService, ACTIONS } from './buildService.js';
export {
  createSourceWatcher,
  shouldIgnore,
  scanTree,
  scanTreeAsync,
  diffFingerprints,
  probeNativeWatch,
  DEFAULT_WATCH_ROOTS,
  DEFAULT_POLL_MS,
} from './watcher.js';
export { publishDirectory, PublishTargetError, BUILD_SIDE_EFFECTS } from './publisher.js';
export { mirrorSource, clearMirror, DEFAULT_MIRROR_CONCURRENCY } from './sourceMirror.js';
export { parseBuildOutput, parseBuildStats, formatDiagnostic, extractLocation } from './buildErrors.js';
export { runCommand, hugoArgs, defaultHugoBin, readHugoVersion } from './command.js';

// Where a build happens, as opposed to where the site lives.
//
// The source tree and the published output sit on a mount where a single file operation costs
// ~15ms (measured: building this site there takes 8.0s, the same build from a local copy
// 0.86s, with identical CPU time). The build therefore runs against a copy on the fastest
// filesystem available - the system temp dir - and only the result is published back to the
// site. Nothing canonical ever lives here: the scratch directories are rebuilt per build and
// may be deleted at any time.
export function defaultBuildPaths({ editorRoot, siteRoot, workRoot = join(tmpdir(), 'hugo-editor-build') }) {
  const buildRoot = join(editorRoot, '.build');
  const slug = siteRoot.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'site';
  const work = join(workRoot, slug);
  return {
    buildRoot,
    workRoot: work,
    // Hugo's source for the build: a mirror of siteRoot, kept out of the way of the real tree.
    sourceDir: join(work, 'source'),
    // Where Hugo writes; published to publishDir only after a clean exit.
    stagingDir: join(work, 'output'),
    cacheDir: join(buildRoot, 'cache'),
    // Which files the publish target already has, so an unchanged page is not rewritten.
    publishManifest: join(buildRoot, 'publish-manifest.json'),
    publishDir: join(siteRoot, 'public'),
  };
}
