# AGENTS.md — Hugo Visual Editor

A local editor for the Hugo site in `/projects/site` (theme: hugo-theme-stack).
The site is the source of truth; this app only ever touches it through explicit,
recoverable writes.

Phase 1 was the lossless front-matter engine, Phase 2 the edit -> build -> preview loop,
Phase 3 content management across the whole content tree (browse / create / form-edit /
delete / restore). Where Phase 1 could only write one section, the editor now covers
`post`, `page`, `categories` and the content root. Phase 6 added binary resources,
Phase 7 the cross-document relations (tags and a page's `links:` list) - each of them a
named change set, one confirmation, then a transaction with read-back verification.
Phase Insert E added the reference model: which strings in Markdown and in front matter
Hugo can actually resolve into an image, checked before anything is written.

## Commands

```bash
node --test          # full suite (490 tests)  — npm test
node scripts/acceptance.mjs   # real-site gate (T1..T20) — npm run accept
npm run build:web    # rebuild web/ -> dist/ (Vite + Vue 3)
node server/index.js # run the editor on http://127.0.0.1:1314/editor/
```

`npm run accept` is the gate that matters: it runs against the **real** site, hashes the
whole source tree before and after, and fails if a no-op save or a build changes a byte.

## Docs

`docs/用户手册.md` is the user manual (Chinese): startup, every view, the two-step
write rule, keyboard/slash commands, the API list and the known limitations. It is
written for the site owner, so keep it in step with the UI text when the UI changes.
Screenshots live in `docs/images/`.

## The layers (do not blur them)

| layer   | path                                | rule                                        |
| ------- | ----------------------------------- | ------------------------------------------- |
| source  | `/projects/site`                    | canonical; never rewritten by tooling       |
| build   | `/tmp/hugo-editor-build/<site>/output` | Hugo runs here, never inside `site/`; on the fast mount on purpose |
| mirror  | `/tmp/hugo-editor-build/<site>/source` | byte copy of the source; Hugo builds *from here* |
| output  | `/projects/site/public`             | published **only** after a build exits 0    |
| backups | `/projects/editor/.backups`         | pre-save copies, outside `site/`            |
| trash   | `/projects/editor/.backups/trash`   | deleted documents + `manifest.json`, same tree |
| editor  | `/projects/editor/dist`             | the UI bundle, served at `/editor/`         |

## Environmental facts that cost real time to discover

* **`/projects` is a v9fs (9p) mount and inotify does not work there at all.** Not just
  recursive watching — a single non-recursive `fs.watch` on one directory never fires
  either. `/tmp` is overlayfs and behaves normally, so **unit tests that rely on
  `fs.watch` pass while the real site silently gets nothing.** Verify watching changes
  against `/projects/site`, never against a temp dir.
  - Consequence: source watching is **polling-first** (`scanTree` fingerprint of
    `mtime:size`, default 1500ms). `fs.watch` is registered as an accelerator only.
  - `probeNativeWatch()` answers "does this mount deliver inotify events" by writing into
    a directory the editor owns; `/api/site` reports it as `watch.nativeWatchSupported`.
* **Per-file I/O on v9fs is very expensive**: one file operation costs 5-16ms of latency,
  which is the price of every listing, scan and copy in this project. Measured on this
  machine: 49 serial stats 57-70ms, 49 serial reads 84-104ms, one sequential copy of the
  474-file output 6.1s. Almost every performance change in this codebase is really one
  change: issuing those operations concurrently through `src/util/pool.js` instead of one
  after another, and keeping bulk work off the v9fs mount entirely.
* Hugo itself is 2.5x faster when it builds from `/tmp` than from the site mount (7.5-8.3s
  vs 19-22s for the same site, measured). That is why the build mirrors the source to
  `/tmp` first and Hugo never reads `content/` directly.
* Hugo writes inside the source tree on every build (`assets/jsconfig.json`,
  `resources/_gen/**`, `.hugo_build.lock`). These are filtered out of watching, and the
  only tolerated source-tree change during a build is `assets/jsconfig.json`.
* Hugo aborts on the first error and can leave partial output behind — that is exactly why
  staging exists.
* **Reading the content tree is per-file latency, not CPU**: a listing stats and parses
  every file in the section. It is now cached per file (validated by the file's own
  `mtime:size` plus its bundle directory's) *and* walked concurrently, which is what took
  `GET /api/documents` from 365-616ms to 65-90ms and `readSection('post')` from 214-315ms
  to 28-30ms. See `src/site/contentReader.js` (`IO_CONCURRENCY`) and `src/util/pool.js`.
* The watcher's poll is the same problem: walking the fast roots serially cost 155-460ms
  every 1500ms, taken from the editor's own disk work. `scanTreeAsync` now issues its
  readdirs and stats through the limiter (25-94ms, same fingerprint). The synchronous
  `scanTree` is still used for the initial fingerprint at startup and for the
  `diffFingerprints` unit tests - it blocks the event loop, so do not put it on a timer.

## Phase Insert A: performance (accepted, closed)

Measured baselines, all on this machine, before the fixes above: cold build 2901ms
(mirror 697 / hugo 308 / publish 1890 - publish is where a cold build still spends most of
its time), warm no-op build 1651-1659ms (publish 734-758, everything skipped), save to
visible preview 1.6-2.0s, page HTML 31-51ms, `GET /api/documents` 365-616ms.

After: `GET /api/documents` 65-90ms, `readSection('post')` 28-30ms, watcher poll 25-94ms,
publish (warm) 441-478ms, save to visible preview 1.7-2.2s.

Rules this phase settled:

* `src/util/pool.js` (`createLimiter`, `inPool`) is the one way to parallelise filesystem
  work here. Do not add a second pool, and do not call `statSync`/`readFileSync` in a loop
  over a directory.
* A cached description must be validated against the file it describes. The
  `mtime:size` signature is the contract; a write through the service also drops that
  file's entry outright.
* Publishing skips files whose contents match the manifest, so a warm build rewrites
  nothing (474 skipped). Deleting output stays **opt-in** (`clean`), because it is the one
  thing here that could destroy something a user put in `public/` by hand.
* Known open item: because `clean` is opt-in, old content-hashed assets
  (`ts/main.<hash>.js`) accumulate in `site/public` as the hash changes. A safe prune
  (delete only files *we* published that the newest build no longer emits) is not
  implemented; the leftovers are removed by hand.

## Invariants worth protecting

1. `confirm: true` is required for any write; a no-op save must not touch content, mtime,
   or backups. This holds for the Phase 3 endpoints too: `POST /api/documents/create` and
   `POST /api/documents/delete` answer with a plan when `confirm` is absent, and only the
   confirm call touches disk.

2. A failed build publishes nothing and must not advance the preview generation.
3. The editor's own save must not be reported back by the watcher as an external change
   (`watcher.absorb`) — otherwise every save costs two builds.
4. Editor artifacts must stay outside `site/` (checked by acceptance T5).

## Phase 3 notes

* The write scope is a **list of sections** (`sections: ['post', 'page', 'categories', '']`)
  threaded from the server into `PathGuard`; `''` means the content root. `''` must stay
  last in the list because the overview is ordered by it, and `PathGuard` must never be
  handed a section it cannot tell apart from the root.

* **Deletion is a move, not a destroy**: `removeDocument` relocates files into
  `.backups/trash/<id>/files/<relPath>` and writes a `manifest.json`
  (`{id, relPath, kind, files, bytes, entries, deletedAt, restoredAt}`). `files`/`bytes`
  are **counts**, not lists; the per-path truth is `entries`
  (`[{relPath, kind, files, bytes, transport}]`, see the Phase 4 notes).

* The front-matter form is a *request*, not an editor: `describeFields` marks fields
  `editable: false` when the engine cannot rewrite them losslessly (maps, unusual
  scalars), and the form shows the engine's own `reason` instead of guessing. A blank
  input is **not** a request to blank the field (`lastmod: ""` breaks Hugo's date
  parsing); removal has its own explicit control.

* Client-side rules that decide *whether a save happens* live in `web/fieldDrafts.js`
  (plain ESM, no Vue) so they can be tested with `node --test` instead of by clicking.

## Phase 4 notes: content kinds, taxonomy pages, delete scopes

The site's content is Article + Page + Category + home page, and it is written in three
bundle forms. Two words that must not be conflated:

* `kind` is the **bundle form**: `standalone` (`post/x.md`), `leaf-bundle`
  (`page/about/index.md`), `branch-bundle` (`categories/Documentation/_index.md`).
* `contentKind` is the **type the editor shows**: `article`, `page`, `category`, `other`.

* Types are **derived from the section**, never hardcoded per path:
  `deriveContentKind({section, kinds})` uses `DEFAULT_CONTENT_KINDS`
  (`article: ['post']`, `page: ['page']`, `taxonomy: ['categories', 'tags']`).
  `readTaxonomies({siteRoot})` reads `[taxonomies]` from `config/_default/hugo.toml`; this
  site declares none, so Hugo's defaults (`categories`, `tags`) are what applies - do not
  "fix" that by writing the table into the config. `.md` resources and `_index.md` are
  decided by filename (`isBranchIndexName`), section `''` belongs to `other`.

* A category page is a **branch bundle**, so `CREATE_SECTIONS` includes `categories`:
  creating one writes `categories/<slug>/_index.md`, which is the only way a term gets a
  description page of its own. Its sibling `_index.<lang>.md` files are the same page in
  other languages; its images are *resources of that page*.

* Delete scopes are `document` and `bundle`, and `bundle` means **the page**, not the
  directory: a branch bundle deletes the `_index.*.md` of every language plus the resources
  beside them and **keeps child pages** (`plan.kept` lists them, and the plan says so in
  `warnings`); a leaf bundle deletes the whole directory. `content/_index.md` refuses the
  `bundle` scope - its "bundle" is the entire content tree. A branch-bundle `bundle` delete
  is therefore several paths in ONE trash entry (`entries[]`), and one restore puts them
  all back.

* `PathGuard.resolveForRemoval` refuses a **section root**, and "section root" means an
  existing directory at depth 1 (or a depth-1 path that does not exist). A top-level *file*
  such as `content/_index.md` is removable: it is content the editor lists and edits, and
  the section-root rule exists to stop a section being deleted, not a file. Listing a
  branch bundle's directory (which is never what gets removed) goes through
  `resolveForRead`, while every file that does move is validated as a removal target.

* A single-file delete must count as **one document, zero resources** - not as a resource
  of some bundle. `deleteTargets` special-cases `document` on a branch bundle, because the
  document-scope finder reports that page's own files as resources.

## Phase 5 notes: site settings / TOML config

The settings screen edits the site's own `config/_default/*.toml`. The whole point is that
it is a *form over TOML*, not a TOML rewriter: key order, comments, blank lines, quoting and
alignment of the keys a save touches all survive, and the keys it does not touch are not
rewritten at all.

* Files: `hugo.toml`, `params.toml`, `menu.toml`, `languages.toml`, `markup.toml`,
  `related.toml`. `configRoot` (`server/index.js`) is the only writable directory, and it is
  a `configGuard` allow-list of exactly these files - not a prefix match.
* **Theme defaults are read-only.** `readThemeInfo({siteRoot})` reads the theme's own
  `config/_default/*.toml` (and `theme.toml` version) so a row can show `source: 'theme'`
  versus `source: 'site'`. Saving a theme-default value writes an override into the *site's*
  file; the theme tree is never written.
* Descriptors (`src/settings/describe.js`) own the labels, the kind of control, the
  destructive hints and validation (`iconNames` from `themeInfo.js` for `icon = "..."`).
  Per-language keys (`title`, `sidebar.subtitle`, ...) carry `perLanguage: true` and expose
  `languageRows[]`; a language override's id is `<rowId>@<lang>`, and it is only written to
  `languages.toml` when it has a value.
* The TOML engine (`src/settings/toml/`) is value-based: `readToml` gives `values` for the
  UI, `applyEdits` splices text. Array edits are validated by **net delta** (the array's
  length must move by exactly the number of inserts minus removes), not by an expected
  absolute length - a `menu.toml` array may already hold entries the engine did not count.
* Unmanaged keys are not "unsupported", they are *read-only*: `describe` reports them under
  `unmanaged` per file and the panel lists them, precisely so a save is visibly scoped to
  what the form shows.
* The API mirrors the content API: `GET /api/settings` (describe), `POST /api/settings/preview`
  (dry run, writes nothing), `POST /api/settings/save` (needs `confirm: true`). A save backs
  up first, writes atomically and reads the file back; the server schedules its own rebuild
  afterwards, so the change is visible in the published output, not just on disk.

## Phase 6 - binary resources (assets)

* A resource is **not** a document that happens to be binary. It has its own model
  (`src/site/resourceModel.js`: identity = bytes, owner = the bundle it sits in, capabilities =
  replace/delete, never "edit front matter"), its own byte layer (`src/site/bytes.js`: sha256,
  magic-number sniff, byte-exact atomic write) and its own application service
  (`src/site/assetService.js`). Nothing in Phase 1-5 changed shape for it.
* Locations: `content/<bundle>/<file>` is a page resource (writable when the bundle's section is
  in the editor's scope); `static/` and `assets/` are listed and previewed but **never written** -
  replacing a file the theme loads has no back-reference to validate. The guard resolves reads
  for them through `resolveSiteAssetForRead({location, relPath})`, whose roots come from
  `createDocumentService({ staticRoot, assetRoot })` (defaults: `<site>/static`, `<site>/assets`).
* The name and the bytes must agree: an upload's extension has to be in `UPLOAD_EXTENSIONS`
  (`.png .jpg .jpeg .gif .webp .avif .bmp .ico .pdf`) *and* the sniffed format must allow that
  extension, so a script renamed to `.png` never lands. SVG is deliberately not writable.
* Every operation has the two-step shape the rest of the editor uses: a plan that writes
  nothing (`planUpload` / `planReplace` / `planRemove`, exposed as a POST *without* `confirm`),
  then a write behind `confirm: true`. Uploads never overwrite (they answer with a suggestion),
  replaces keep the path (so Markdown references stay valid) and always take a backup first, and
  a replace whose bytes are identical is a **no-op** that touches nothing.
* Deleting a resource is a reversible move: it goes through `trash.js` as one entry with
  `reason: 'asset-delete'`, and `/api/trash/restore` puts the identical bytes back (trash restore
  is shared with the content tree - the manifest carries real paths, nothing is rebuilt from
  text). A restore is byte-for-byte verifiable with sha256.
* Routes: `GET /api/assets` (bundles + resources + the read-only site trees + `summary`/`limits`),
  `GET /api/assets/raw?location=&path=` (bytes, with an ETag/304; only for a resource the service
  already listed and only for a previewable type), `POST /api/assets/{upload,replace,delete}`.
  The JSON body limit for uploads is 8 MB (base64) while the decoded asset limit is 4 MB.
* **Deleting a resource must also remove its published output.** `publishDirectory({ prune })`
  removes files the *manifest* says this publisher wrote before and did not write now, and skips
  anything whose bytes changed since (that is somebody's hand-edit, not a stale output). The
  server enables it (`pruneOutputs: true`); it is the narrow alternative to `clean`, which would
  also delete files the user put in `public/` by hand.
* The UI keeps its decision logic out of `.vue`: `web/components/AssetPanel.vue` only renders
  what `/api/assets` returned (preview URLs included) and posts back plans/confirmations.

## Phase 7 notes: cross-document relations (tags + links)

* The shape is the same three steps as everywhere else, but the unit is a **change set**
  instead of a document: `src/relations/changeSet.js` holds named per-file changes with
  counts and rendered diffs, `src/relations/transaction.js` applies them (prepare ->
  validate -> backup -> write -> read back -> commit, rolling back by *reversing* the
  changes on any failure), and `src/relations/relationService.js` builds the plans
  (`listTags` / `tagDetail` / `planTagEdit` / `planTagRename` / `planTagPageCreate` /
  `links` / `planLinkEdits`) for `GET /api/tags`, `POST /api/tags/{plan,apply}`,
  `GET /api/links`, `POST /api/links/{plan,apply}`.
* Front-matter sequences are rewritten **minimally** by `src/frontmatter/sequence.js`: one
  item or one field is spliced, and comments, blank lines, quoting style, indentation and
  key order survive. That is why a tag rename across 12 documents shows up as one changed
  line per file, and why the acceptance can demand byte-identical restoration.
* Tag identity is the **canonical** value Hugo reports in the tag index (`tag:`), not the
  spelling in the document (`asWritten:`); `markdown` and `Markdown` are one term, and the
  list shows the synonyms it absorbed. Renaming onto a name the site already uses is
  refused with 409 - that is a merge, and it has to be asked for explicitly.
* A taxonomy metadata page only exists at `content/<taxonomy>/<term dir>/_index.md`
  (`tags/Gallery/_index.md`). Measured against Hugo 0.167: a nested path such as
  `content/tags/meta/gallery/_index.md` does **not** attach to the term, and the term page
  gets its title from that page - but this theme renders the *title* and not the page
  `body`, so an acceptance marker has to be the title. Renaming a tag moves the directory
  with it (Hugo derives the term's URL from the directory name, `tags/Gallery 相册/` ->
  `/tags/gallery-相册/`), and an empty leftover directory is not a document: the service
  has no call for it, so deleting the page and then the empty tree is plain `rmSync`.
* `DELETE_SCOPES` is `['document', 'bundle']` - there is no `'file'` scope. Use
  `removeDocument({ path, scope: 'document' })` for a branch index like `_index.md`.
* Link lists live in one front-matter key (`links:`), but the *body* of that page may
  contain a fenced copy of the same list as documentation. Every assertion about the list
  must be scoped to the front-matter block (from `^links:` to the next top-level key),
  otherwise the example's items are counted too. The editor never touches the body, and
  the acceptance checks that as well.

## Testing notes

* Tests must not use mocks for the file paths they assert on; the P1 suite writes to real
  temp trees and the acceptance script runs on the real site.
* Corpus counts are asserted against the real tree (`article 25 / page 16 / category 4 /
  other 4`, 49 documents). Adding content to `site/content` is what breaks them - update
  them deliberately, they are there to catch a type that silently disappears.
* Acceptance T12 (real content) and T13 (real `config/_default`) are the only sections that
  write the real tree. Both drive the *running* editor server when one is watching the site,
  because **exactly one builder may own a staging directory at a time**: a second
  `BuildService` pointed at the same `stagingDir` while the server builds makes Hugo fail
  with a confusing `error copying static files: ... no such file or directory` and can leave
  a half-published output behind. When no server is up they fall back to an in-process
  service + `BuildService`. Both restore the original **bytes** (not the original field
  values - the form may reformat a field it writes) and re-hash the tree afterwards, so the
  run must end byte-identical.
* Corpus counts (25 -> 26 articles, 49 -> 50 documents) moved when `content/post/红颜如霜.md`
  was added: `test/contentReader.test.js`, `test/server.test.js`, `test/acceptance.test.js`.
  Facts like `bundlePaths`/`groups` are derived there, not copied.
* Settings/asset tests **derive their expectations from the real site** (the site's own
  `params.toml` values, so `params.footer.since` is read rather than assumed to be 2020, and a
  `colorScheme.default` that the site already overrides reports `source: 'site'`). Hard-coded
  "theme default" values are what break when the user personalises their config.
* T14 (Phase 6) writes the real tree through the **running server's HTTP API** for the same
  reason T12/T13 do, and it *converges*: a write schedules a build, the watcher may schedule
  another, so the published state is polled (pushing another build when the interval passes)
  instead of sampled once. It cleans up through the same API (delete to trash, replace back the
  original bytes) and re-hashes the tree, so the run must end byte-identical.
* T13 asserts the settings change *reaches the published HTML* (`colorSchemeKey, "dark"`,
  `2019 -`, the ja subtitle marker), not just that the file on disk changed - a settings
  editor whose effect cannot be seen in the output has not been verified.
* Prefer `node --test`; there is no test framework beyond `node:test` + `node:assert/strict`.
* The UI is verified by building it (`npm run build:web`) and by the endpoint-level tests;
  there is no jsdom/vitest, so keep decision logic out of `.vue` files.
* The in-app browser tool's element indices go stale while the editor polls build status -
  do not rely on click-throughs for verification; assert against the HTTP API instead.
* T15 (tags) and T16 (links) write the real tree through the running server's API like
  T12-T14, converge on the published output, and reverse every step in a `finally` so a
  failed assertion cannot leave the user's tags renamed or a temporary `content/tags`
  tree behind. The run-level byte check (`sourceHashes()`) is taken **before T15** and
  compared after T16, so a leftover from either block is a failure. The tag sample is
  `post/pagination-test-01.en.md` (and its `-02..-12` siblings); the links page is
  `page/links/index.md`, whose English sibling is published at `/en/p/...` because the
  site's default language (`zh`) is the only one without a URL prefix.

### Phase Insert C: the baseline owns its data (2026-09-30, accepted)

The user deleted the theme's twelve demo posts and rewrote several pages; that is legitimate
content work, and it turned the suite red (416 pass -> 352 pass / 64 fail) because 14 test files
and the pinned counts in `test/acceptance.test.js` were reading the *live* tree. The insert takes
option (b) from the old note: **the tests own their data.** `test/fixtures/README.md` states the
rule and documents the corpus; `test/fixtures/harness.js` is the only module that knows the
paths, and `makeFixtureSandbox(t)` hands a writable copy to any test that writes.

* Migrated this session: `acceptance` (now 20 documents / 9 writable / 11 read-only, and the
  fixture tree is proven byte-identical after the sweep), the settings/build group
  (`buildService`, `editorShellMount`, `markdownPreservation`, `serverBuild`, `serverSettings`,
  `settingsForm`, `settingsHugo`, `settingsService`, `settingsSocialIcons`, `tomlEngine`), the relations/server group
  (`tagRelations`, `linkRelations`, `serverRelations`, `sequence`, `server`, `serverPhase3`) and
  the content group migrated earlier (`documentService`, `documentLifecycle`, `contentTypes`,
  `fields`, `frontmatter`, `contentReader`, `transaction`, `assets`, `assetsApi`, `fieldForm`).
* `npm test` is **424 passed / 0 failed**. The user can delete an article, add a language or
  rewrite a page without turning it red - that is the whole point of the insert.
* One deliberate exception: the last test of `test/acceptance.test.js` walks the real site to
  prove the editor's own files and backups are never installed *inside* the site Hugo builds.
  That is a statement about the deployment, not about the editor, so it cannot use a fixture.
* `scripts/acceptance.mjs` still runs against the real site by design (it is the smoke run on the
  user's own site, not a unit test) and still samples `post/pagination-test-01.en.md`, the
  `Image Gallery` bundle and `page/links/index.md`. As of 2026-09-30 it is **red**: 120 ✅ / 6 ❌,
  then an uncaught `ENOENT` on `public/p/image-gallery/hudai-gayiran-3Od_VKcDEAA-unsplash.jpg`.
  The ❌ are coupling or drift, not regressions - the published HTML page count (73), the category
  delete counts, the `ja` overlay restore, the published footer year, the new asset in `public/`.
  The run leaves the source tree intact: every file it rewrote (the two content pages, the four
  config files, the replaced image) was compared against the editor's `.backups` copy and matches,
  and the one artifact it left behind (the uploaded png, parked in `.backups/trash`) was removed.
  Next step, undecided: (a) restore the twelve demo posts from the trash and keep the script on
  the real site, or (b) point the script at a fixture copy and keep the real site out of the gate
  entirely. Take (b) if the gate should be runnable by anyone, at any time.

## Phase 8 notes (modern editor shell + Markdown input)

* The shell is `web/`: `App.vue` (one owner of state) plus the panels, and four plain modules -
  `commands.js` (the Ctrl+K command table), `theme.js` (light/dark/system store), `toast.js`
  (notifications) and `keymap.js`. Anything with a *policy* in it belongs in a `.js` module, not in
  a `.vue` file: `test/editorShell.test.js` tests the stores and the command table directly, which
  is only possible because they take their globals (`storage`, `root`, `media`, `now`) as
  parameters.
* Both stores hand the current state to a listener **immediately on `subscribe`**. A component that
  subscribes in `onMounted` therefore does not have to also read the store by hand - but it does
  mean a subscriber sees one extra notification at startup.
* T17 (Phase 8) runs the Markdown commands against the **real** `post/Markdown Syntax/index.md` and
  hashes the file before/after: the promise is that a formatting command is a selection operation
  in memory and can never touch the disk. T18 builds a throwaway `mkdtemp` repository, because the
  user's repository has no commits yet: `diff` / `log` / `show` / `commit` can only be verified on
  a repository that has history, and doing it in a temp repo means the gate can never stage or
  commit anything of the user's.
* **`lineStart(text, 0)` used to be off by one** when the text starts with a newline
  (`lastIndexOf('\n', -1)` is clamped to 0, so offset 0 looked like the start of line 2), and
  `selectedLines` could then return a block whose end was *before* its start. `replaceRange` on an
  inverted range appends the rewritten line instead of substituting it - pressing the bullet-list
  button with the caret at the very start of a body that opens with a blank line duplicated the
  first paragraph. Both are fixed; `test/markdownCommands.test.js` keeps the invariant ("the
  selected line's body survives, every other line is byte-identical") for every line command.
* The in-app browser tool serves **stale `get_content` output** after a click, exactly like its
  element indices: after clicking something, confirm through `browser_get_state` (the element
  labels there are live) or through the HTTP API, never through the extracted page text. A "panel
  stuck on loading" was really a cached read of the pre-mount render.
* `public/` and `.backups/` are build/backup output. The repository now has an initial commit
  (branch `phase-8-modern-editor`, baseline of the whole project) and a root `.gitignore`, so the
  git panel shows a real history and a short change list; before that commit everything showed as
  untracked, which is why the change list is filterable by path instead of truncated.

## Insert B note (the article selector must stay mounted)

* The Phase 8 shell rewrite rebuilt the content view as rail + workspace + inspector and, in doing
  so, dropped the **mount point** for the article selector: `DocumentList.vue` stayed imported,
  the `visibleDocuments` computed that the topbar search feeds stayed defined, and the search kept
  filtering - but nothing rendered the list. No CSS was hiding it; the pane simply was not in the
  template. A document could then only be reached through the Ctrl+K palette, which is not the
  flow the view is built around.
* The selector lives in `App.vue` as `<aside class="browser">`, the second column of the content
  view (`.shell.with-browser`, width token `--browser-w`), and it renders `DocumentList` with
  `:documents="visibleDocuments"` and `@select="openDocument"`. It is **open by default**
  (`listOpen = ref(true)`) and can only be collapsed by the user - via the workspace head button,
  the status bar item or `toggle-list` in the palette - because a collapse-by-default list is a
  missing feature, not a tidy layout.
* Two traps are now tests, in `test/editorShellMount.test.js`:
  * **Orphans.** Every `.vue` import in `App.vue` must appear as a tag in the template, and every
    `const x = computed(...)` must be referenced somewhere other than its declaration. This is the
    guard that would have caught the original regression (it reports `DocumentList` and
    `visibleDocuments` on the pre-fix file).
  * **Hiding by CSS.** No rule whose selector is `.browser` may set `display: none`,
    `visibility: hidden`, `opacity: 0`, a zero width/height or `clip-path`, and every
    `--browser-w` at every breakpoint must stay positive. Narrow windows therefore *narrow* the
    list rather than hiding it, unlike the inspector (which is deliberately hidden below 1200px).
  * The same file also walks the flow against the real tree: `/api/documents` -> pick an article
    -> `/api/documents/raw` -> the text equals the file byte for byte, with the hash and mtime
    unchanged after every document in the tree has been opened.
* Reading `.vue` sources in a test means slicing by markers, and `indexOf(end)` searches from 0 by
  default: the shell has nested `</header>` and `</aside>` tags, so the end marker has to be
  searched *after* the start marker. Getting that wrong makes a structural test assert against the
  wrong block and pass for the wrong reason.

## Phase 8 note (one shell, one stylesheet)

* The look of the application is owned by two files and by nothing else: `web/styles/tokens.css`
  (every colour, size and gap, light and dark) and `web/styles/base.css` (the shell, the page and
  pane structure, and the shared primitives - `.btn`, `.badge`, `.chip`, `.list-item`, `.panel`,
  `.view`, `.icon`, `.error-line`, ...). A component keeps only its own layout in its scoped block,
  so redefining `.btn` in a view is how "the button in the dialog is 2px shorter" starts.
  `test/designSystem.test.js` holds that line: a component may not redefine a primitive, and no
  component style may name a colour of its own.
* Two structures carry the whole UI, and every view uses one of them:
  * a **page** is `.view` > `.view-head` + `.view-body` (AssetPanel, RelationsPanel,
    SettingsPanel), sharing `--page-pad` with the rest of the shell;
  * a **pane** is a head plus a body at one height (`.panel`, `.browser`), which is what makes the
    selector's header, the workspace header, the inspector cards and the preview header line up.
  Misalignment was almost never a padding tweak: it was two controls of different heights, a glyph
  with different metrics from an SVG, or a view that had invented its own header. So the primitives
  are the fix - one `--control-h`, and `.icon` as a fixed centred box for both emoji and SVG, with
  every decorative glyph carrying `aria-hidden="true"` and its meaning in the label beside it.
* The rail is built from the `VIEWS` list, and each command in `commands.js` carries the same glyph
  as the rail entry it mirrors, so the palette and the rail cannot disagree about what a view is.
* UI work is verified in a browser, not only by tests. `node server/index.js` wants port 1313, but a
  second instance can run on any free port without disturbing the first: build first
  (`npm run build:web`), then start one that never writes to the site and open it:

  ```bash
  node -e "import('./server/index.js').then((m) => m.createEditorServer({ port: 8912, host: '127.0.0.1', watchSources: false, autoBuildOnSave: false }).listen(8912))"
  # then http://127.0.0.1:8912/editor/
  ```

  Read dimensions from the rendered page (the labelled interactive elements are live there), never
  from a scoped stylesheet.
* The site belongs to a person who may be editing it *while* acceptance runs, in the editor window
  that is usually already open. Two consequences, both now built into `scripts/acceptance.mjs`:
  * expected values are **derived from the site** rather than pinned: the footer year comes from
    `params.footer.since` and the theme's own rule (`<since> - <year>` only when the two differ),
    the document kinds from the directory layout, the tag vocabulary from the documents' front
    matter - so adding an article never reads as a regression;
  * the whole-tree "the site came back byte for byte" checks **attribute** every difference: paths
    this run named must be restored, and anything else that moved is reported as an outside write
    (`⚠️`) instead of failing the run.

## Insert D note (social icons: Phosphor + picked pictures)

The Stack theme resolves a social icon with `resources.GetMatch "icons/<name>.svg"` and **stops the
build** when that file does not exist, so "let the user pick any icon" means "the editor has to
install the SVG". Three value forms are accepted for `[[social]].params.icon`, and only the first
is what the site allowed before:

1. a theme icon name (`brand-github`, `rss`) - written as it is, exactly as before;
2. `phosphor-<name>` - the original SVG from the optional `@phosphor-icons/core` dependency
   (1512 names under `assets/regular/`). The package does **not** export `package.json`, so its root
   is found from the main entry, not from `<pkg>/package.json`;
3. `image:<location>:<path>` with `location` in `content` / `static` / `assets` - an SVG source is
   copied as it is, anything else is wrapped in `<svg viewBox="0 0 24 24"><image href="data:...">`
   so it can sit in the theme's `<svg fill="currentColor">` box.

2 and 3 are materialised at **save** time into the site's own `assets/icons/`; the value written to
`menu.toml` is the name that file resolves to. A collision is resolved by **creating a `-2` file,
never overwriting** (`writeIconFile` uses the `wx` flag), so a hand-drawn icon is safe. A theme icon
that also exists in Phosphor keeps the theme's (`rss`, `home`, `link`, `search` are in both sets);
`phosphor-<name>` always means Phosphor.

* `src/settings/socialIcons.js` owns all of it: parsing the value, reading Phosphor/image bytes,
  unique naming, `iconFileStatus` (`noop` / `create`) and `writeIconFile`.
* `settingsService.js` resolves icons while **planning** (`resolveIcon`), carries the SVG bytes in
  the plan, reports them in `preview.icons` (and never writes them there), and writes them only
  after the config files are safely on disk. `changedFiles` includes icon paths, so a missing icon
  is reason enough to save even when every value already matches.
* `themeInfo.phosphorIcons` / `described.theme.phosphorIcons` / `row.phosphorIconOptions` expose the
  names to the form; `SettingsPanel.vue` merges them into the `stack-icons` datalist and adds a
  `或从图片里选…` select fed by the existing `/api/assets` listing (a failed fetch only costs the
  picker).
* Tests live in `test/settingsSocialIcons.test.js` (fixture sandbox plus the real theme copy, so the
  Phosphor list is the installed one). Keep the "preview writes nothing" and "no overwrite"
  assertions if you touch this.

TODO (not done, both small):

* Look at the sidebar in a browser on 1313 with a Phosphor icon and a photo icon: the theme inlines
  the SVG at its own box size, and a photo inside `<image>` deserves the visual check no test here
  can make.
* `scripts/acceptance.mjs` has no step for this yet. It is red for unrelated reasons (deleted demo
  articles - see the Phase Insert C note); once green, a T-step that saves `phosphor-github-logo`
  plus one picture on the real site and asserts the built HTML holds both SVGs would be the honest
  end-to-end gate. This session verified it on a **copy** (`/tmp/hve-icon-verify`) with the real
  `hugo` binary: exit 0, both SVGs present in `public/index.html`. Phase 9 added **T19** in this
  style (a `mkdtemp` repo, no contact with the user's repository) - that is the shape to copy.

## Phase 9 notes: the git panel's two halves (staged / unstaged) and one honest commit

Reuse first, as always: this phase added **no new endpoint and no new dependency**. `gitService.js`
grew a flag, `gitView.js` was extracted from `GitPanel.vue`, and `show()` grew a path. The panel
still reads one repository and writes exactly one thing - a commit of the paths the user ticked.
(Phase 10 added the second write, `push`; see the Phase 10 notes at the end of this file.)

* **`staged` and `unstaged` are two questions, not a synonym for "changed".** `parseStatus` keeps
  the two porcelain columns (`index`, `worktree`) and `classifyStatus` maps them per change:
  `staged: index !== ' ' && index !== '?'`, `unstaged: worktree !== ' ' && worktree !== '?'`.
  A file that is `MM` is both; a file staged only is `staged: true, unstaged: false`.
  **Untracked files are neither** (both columns are `?`) - that is why `counts.unstaged` can be 33
  while `counts.total` is 36 on the real site: the 3 untracked files have their own kind and their
  own row badge, and `scopeSwitchAvailable()` hides the scope switch for them because the index
  side does not exist. Do not "fix" this by counting untracked as unstaged - it would make the
  counts disagree with the rows.
* **`GET /api/git/diff?staged=` compares against the literal string `'true'`** (`server/index.js`).
  `staged=1` is silently read as `false` and you get the worktree diff - which is exactly how a
  parity script lies to you. The UI sends `staged=${scope === 'staged'}`. The service side is
  `git diff [--cached] <range> -- <paths>`, so a half that has no changes is an empty patch, not an
  error; `web/gitView.js` (`emptyScopeHint`) says which half to look at instead.
* **Clicking a history row is "show me the whole commit".** `show({sha})` runs `git show --format=`
  (no pathspec) and `show({sha, path})` narrows to one file; the commit's author/date/subject come
  from a separate `--no-patch` call, which is why the patch text equals `git show --no-color
  --format= <sha>` and *not* a bare `git show <sha>` (that one carries the header). The patch is
  **not** scoped to the site prefix: a commit that only touched `editor/` shows its patch with the
  file marked `outside: true, path: null`, and the panel does not offer a diff it could never
  produce from the site root.
* An unknown or rewritten sha is a **state**, not a crash: `show` throws `GitUnknownCommitError`,
  `classifyRepositoryFailure` does not swallow it, and the server maps it to **409** with
  `{error, stderr}` (it used to be a 500).
* Reading is never writing. T19 asserts that `status` / `diff` / `log` / `show` leave `HEAD` and
  `.git/index` byte-identical, which is the property that lets the panel run on the user's
  repository at all. Reads also run with `GIT_OPTIONAL_LOCKS=0` / `GIT_TERMINAL_PROMPT=0`; the
  commit itself is still `git add -- <paths>` + `git commit --no-verify -m <message> -- <paths>`,
  so an already-staged file that is *not* ticked cannot slip into the commit.
* `web/gitView.js` is where the panel's decisions live (kind letters, preferred diff scope, counts
  label, blocked-commit reason, repository notice, empty-scope hint) because there is no jsdom:
  `test/gitView.test.js` calls them directly, including a cross-check that every kind the service
  can report has a letter. If you add a kind in `gitService.js`, add the letter or that test fails.
* **`test/designSystem.test.js` now compiles every `.vue` file** with `@vue/compiler-sfc` (the same
  compiler vite uses). It exists because this phase introduced exactly the bug it catches: after
  extracting `preferredScope` into `web/gitView.js`, the local copy stayed behind in `GitPanel.vue`,
  `node --test` was still green, and only `npm run build:web` failed with *Identifier
  'preferredScope' has already been declared*. Run `npm run build:web` as well - the test is fast,
  the build is the authority.
* Acceptance gained **T19** (Phase 9), in the T18 style: a `mkdtemp` repo **with a site subdirectory
  and an outside file**, so it can assert the outside file is not listed as a site change and is
  reported as `outside` in `show`. It covers the two diff halves, the read-does-not-write property,
  "commit clears both halves", whole-commit vs narrowed `show`, and the 409 mapping - and it never
  stages or commits anything of the user's.

### The acceptance script's real state (measured 2026-09-30, this session)

`npm run accept` on the **working tree as it stands** stops early, and both stops are the Insert C
content drift, not Phase 9:

* T14 dies with an uncaught `ENOENT` on `public/p/image-gallery/...`: the 相册 bundle carries an
  uncommitted `draft: true`, so the page is not published and the scenario's assertion cannot be
  satisfied by any build. (Proved independent of the editor: a clean `/projects/.bin/hugo` run into
  a temp destination does not publish `/p/image-gallery/` either.)
* T15 reads `post/pagination-test-01.en.md`, one of the twelve demo posts the working tree deletes.

With the **committed** site content temporarily restored (`git checkout HEAD -- site`), the same
script runs end to end: **236 ✅ / 2 ❌**, and T19 is 14/14 ✅. The 2 ❌ are
`Category 整页删除：4 语言 _index + 1 图片` and its companion - the working tree adds an untracked
`site/content/categories/Documentation/头像.jpeg`, so the delete plan reports `resources: 2` where
the fixture says 1. Nothing in that run is a Phase 9 regression, and the working tree was restored
byte-exactly afterwards (20 files by sha256, the 12 deletions re-applied, 36 site-scoped changes
back: 21 modified / 12 deleted / 3 untracked). Still the same open decision as Insert C: keep the
script on the real site (and keep it red until the demo content is reconciled), or point it at a
fixture copy. Phase 9 makes the second option cheaper - T18/T19 already prove the git layer works
without touching the user's repository.

**Re-measured 2026-10-02 (Phase Insert E session): 122 ✅ / 4 ❌ with no watching editor running** -
the same content drift as before, plus one stale count:

* T2 now fails on `输出中有 73 个 HTML 页面` - the tree gained `post/第壹篇.md` and
  `post/红颜如霜.md` since the count was written (T1 prints 51 篇).
* T10 (`Category 整页删除：4 语言 _index + 1 图片` and its companion) - the Documentation branch
  bundle now carries 7 resources, so the change set is `{documents:4, resources:7, files:11}`.
* T14 dies with the same `ENOENT` on `public/p/image-gallery/...` (the `draft: true` bundle).

**Re-measured 2026-10-02 (Phase 10 acceptance-cleanup session): 223 ✅ / 0 ❌ / 2 ⚠️ skipped,
exit 1** - with the editor stopped, the gate now runs to the end of the file (T14 → T20) and every
check that *can* be made on this site passes. The two skipped scenarios are the site's content,
not the editor:

* T14's four `public/` checks. `post/Image Gallery` is `draft: true` in all four languages, so Hugo
  publishes neither the page nor its resources; the rest of T14 (upload, replace with backup,
  build, trash delete, restore, byte-exact source restore) runs and passes.
* T15 as a whole. It is written around `post/pagination-test-01.en.md`, deleted in `59ad158`; its
  write steps and its cleanup are skipped with it.

`⚠️ 跳过` is counted apart from failures and keeps the exit code non-zero, so exit 0 still means
every scenario ran against the content it was written for. Two *defects of the gate* found and
fixed in this session: `plan.counts` was `undefined` in the in-process plan drivers, so T15/T16
crashed on the first plan assertion whenever the editor server was stopped - the documented way to
run the gate (`61a485a`); and two assertions froze the owner's content as absolute numbers
(`6e33ff1`).

Still open, unchanged by this cleanup: the gate's content dependence itself. Either keep the demo
corpus on the site (and stay non-zero on the skipped scenarios until it is back) or point the gate
at a fixture copy - note there are now two subjects, T14's demo gallery and T15's English article,
so a fixture has to carry both. Also open (cosmetic, not a 1.0 blocker): a *branch* bundle's trash
entry is labelled with its `_index.en.md` file, a *leaf* bundle's with its directory
(`page/links`); both restore to the right place.

**Run the gate with the watching editor stopped.** With the 1314 instance alive
(`watchSources:true`, `autoBuildOnSave:true`), the script's writes wake the editor's watcher, its
build races the script's build into the same `/tmp/hugo-editor-build/.../output` and
`site/public`, and two extra steps fail with `error copying static files: … woff2: no such file or
directory` (measured: 120 ✅ / 6 ❌ with the editor up, 122 ✅ / 4 ❌ with it stopped). Those two are
an artefact of the measurement, not a defect in the site or the script.

## Phase 10 notes: the push (the second write, and the only one that leaves the machine)

Reuse first again: two new endpoints (`GET /api/git/remote`, `POST /api/git/push`), no new dependency,
no new UI primitive - the push box is built from the same pieces as the commit box it sits under.
`POST /api/git/push` is `{remote?, setUpstream?, confirm?}`: **without** `confirm` it returns
`{plan: {remote, branch, args, command, setUpstream, ahead}}` and writes nothing (not even a git
command that touches the network); with `confirm: true` a refusal is a **409**
`{error, reason, stderr, args}`.

* **A plan is a decision about *now*, so it must not come out of a cache.** `gitService.js` caches
  the repository probe for `cacheMs` (default 5s) so the status polls stay cheap, and `pushPlan` reads
  the repository through `remoteStatus()` - which now calls `requireRepository({ force: true })`.
  This is not paranoia: the T20 scenario (`checkout --detach`, then push) got the *cached* branch and
  would have pushed the branch the user had just left. A display may be seconds stale; the branch a
  push names may not. Regression test in `test/gitService.test.js` (a 60s-cache instance that switches
  branch, then detaches, and asserts the plan and the refusal follow).
* **Nothing shaped like an argument can reach the command line.** The argv is built in the service as
  `['push', '--porcelain', '--no-verify', (--set-upstream)?, <remote>, <branch>]`, and the remote name
  is matched against the output of `git remote` first - so `remote: '--force'` is a
  `GitValidationError` ("unknown remote: --force"), not a force push. Asserted in the unit suite and
  in T20.
* **The service never fetches, never forces, never merges.** The allow-list gained `remote`,
  `rev-list`, `push`; the T18 forbidden list gained `fetch` and `pull` so a later phase cannot add
  either quietly. The consequence to keep: `ahead`/`behind` come from the *local* tracking ref, and a
  branch with no upstream reports `ahead: null` rather than a made-up 0 - so the panel can honestly say
  "nothing to push" and still be rejected by the remote, and the refusal is what tells the truth.
  Do not "fix" the stale numbers by fetching.
* **Credentials are neither stored nor accepted.** The push route's body has no username/token field,
  and `redactCredentials` strips the whole userinfo section from every URL the service reports,
  including those git echoes back in failure output. `GIT_TERMINAL_PROMPT=0` (already set for reads)
  is what turns "waiting for a password" into a classified failure instead of a hung request.
* **Failures are classified in the service, explained in the view.** `classifyPushFailure`
  (`gitService.js`) maps git's stderr to a `reason`; `pushFailureNotice` / `pushBlockedReason`
  (`web/gitView.js`) turn that into a title, an explanation and a copyable command. Check the
  network/unreadable patterns **before** the "cannot read the repository" ones, or a DNS failure gets
  reported as "this is not a git repository" (the reorder is in this phase for exactly that reason).
  The raw stderr is always shown beside the classification - the classification is the editor's
  understanding, the stderr is the evidence.
* **Refusals change nothing.** A rejected push leaves HEAD, the index, the worktree, the tracking refs
  and the remote exactly as they were (asserted in the unit suite and, against a real bare origin, in
  T20). The plan half never touches the network.
* **Acceptance: T20 is extracted, not reordered, when the gate stops early.** `npm run accept` on the
  working tree still stops at T14 (`ENOENT` on `public/p/image-gallery/...`: the 相册 bundle carries
  `draft: true` in all four languages so nothing is published; T15 would then want
  `post/pagination-test-01.en.md`, deleted in `59ad158`). Both are site content, both now live in
  commits rather than in the working tree - which also means the old Phase 9 trick
  (`git checkout HEAD -- site`) no longer changes anything. T20 was run on its own (22/22 ✅) by
  extracting the block; keep doing that rather than reordering the script or editing the site's
  content to make the gate green.
* **UI verification recipe that never touches the user's repository** (used for the push box; the site
  copy is ~27 MB, delete it afterwards): `cp -a /projects/site /tmp/<dir>/site`, `git init` + one
  commit there, `git init --bare --initial-branch=main origin.git` next to it, `git remote add origin`,
  then start a second instance on the copy:
  `createEditorServer({ siteRoot: '/tmp/<dir>/site', port: 8912, watchSources: false, autoBuildOnSave: false })`.
  A peer clone (`git clone` the bare origin, commit, push) is the cheapest way to produce a realistic
  rejection; the session that wrote this verified first push + upstream, the success state and the
  refusal that way, with the user's repo and GitHub untouched.

## Phase Insert E note (the reference model: which image reference Hugo can resolve)

`content/post/第壹篇.md` had `image: categories/Documentation/6afdabb….jpg`. The theme's image
hook (`$resource := $page.Resources.Get ...`) only resolves a **page resource**, so for a
single-file post that value falls through to the Markdown destination, unprocessed: the built HTML
carried `src="categories/Documentation/…"`, a URL relative to `/p/第壹篇/` - a 404 on the card and
in the article, while the file itself is published at `/categories/documentation/…` (the branch
page's own URL, from its `slug`). The editor had two producers of such a value - the image
dialog's "insert reference" for a resource the page does not own, and the free-text cover field -
and no checker.

`src/site/referenceModel.js` is that checker, pure and filesystem-free:

| value | verdict | rule |
| --- | --- | --- |
| `flat.png` (a resource of THIS bundle) | `page-resource` ok | nested paths keep their directory (`images/deep.png`, never `deep.png`) |
| `<two words.png>` | `page-resource` ok | a space needs angle brackets, or Goldmark leaves the line as literal text |
| `/img/logo.png` (a `static/` file) | `site-url` ok | site-root URL, valid from every page |
| `/categories/documentation/x.jpg` | `site-url` ok **iff the last build published it** | a branch bundle publishes its resources under its own URL; publication decides, so a working URL is never refused for looking like a content path |
| `categories/Documentation/x.jpg` | `source-path` / `foreign-resource` no | a content path is not a URL, and the case usually differs from the published one |
| `content/…`, `static/…`, `assets/…` | `source-path` / `pipeline-asset` no | source trees are not referenceable; `static/…` gets a `/path` suggestion |
| `image.png` in a single-file post | `no-bundle` no | only a bundle owns page resources |
| `https://…`, `data:…`, `//…` | `external` ok | left alone |
| `/x.png` the last build did not publish | `unpublished-url` no | "build once, or use the reference the panel gives you" |

* **One implementation.** `referenceForResource` decides what a page resource is called;
  `resourceModel.referenceFor` delegates to it for the assets listing, and the cover/typed-value
  verdicts use it too - the panel cannot offer a reference the checker would refuse.
* **Publication is checked first**, and that ordering is the invariant worth keeping: check the
  content tree first and a legitimately published URL gets refused because a source file with
  different capitalisation looks like it (a real bug in this phase, with the case in
  `referenceModel.test.js`).
* **Server:** `GET /api/documents/reference?path=&value=` answers one value on demand (the image
  dialog calls it before inserting), and `/api/documents/fields` (GET **and** save) annotates a
  document's `image` field with `{kind, ok, value, reason, suggestion}`. A save's response shape is
  unchanged - verdicts are added, nothing removed. Note the shape: `saveFields` returns the
  document *model* under `fields`, with the field array at `model.fields.fields`.
* **UI:** `MarkdownDialogs.vue` refuses to insert a value the verdict rejects and shows the reason
  plus the suggestion; `FieldForm.vue` shows the verdict under `封面图` before any save.
* Tests: `test/referenceModel.test.js` (the decisions), `test/imageReferences.test.js` (one real
  Hugo build of the fixture corpus + theme: flat, nested, card/detail agreement, CJK + space,
  multilingual bundle, static URL vs another page's published URL vs a source path that really does
  404), `test/serverReferences.test.js` (both endpoints, and that a save still answers as before).
  Mutation-checked: returning the file name alone fails the nested case in both levels.
* Limits (also in the manual, 15.6): `assets/` images cannot be referenced from Markdown at all,
  and a single-file post can only use `static/` or another page's published URL. The theme's demo
  bundle `post/Image Gallery/` references `image1.jpg` … `image4.jpg`, which do not exist (4 per
  language file, 16 in all) - harmless today because all four files are `draft: true`, so the page
  is not published. Left as content for the owner, not silently rewritten.
