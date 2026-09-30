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

## Commands

```bash
node --test          # full suite (415 tests)  — npm test
node scripts/acceptance.mjs   # real-site gate (T1..T18) — npm run accept
npm run build:web    # rebuild web/ -> dist/ (Vite + Vue 3)
node server/index.js # run the editor on http://127.0.0.1:1313/editor/
```

`npm run accept` is the gate that matters: it runs against the **real** site, hashes the
whole source tree before and after, and fails if a no-op save or a build changes a byte.

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
    unchanged after every one of the 50 documents has been opened.
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
  (`npm run build:web`), then start one with `watchSources: false` and `autoBuildOnSave: false` (so
  it never writes to the site) - see the launcher snippet in this file's history - and open
  `http://127.0.0.1:<port>/editor/`. Read dimensions from the rendered page, never from a scoped
  stylesheet.
* The site belongs to a person who may be editing it *while* acceptance runs, in the editor window
  that is usually already open. Two consequences, both now built into `scripts/acceptance.mjs`:
  * expected values are **derived from the site** rather than pinned: the footer year comes from
    `params.footer.since` and the theme's own rule (`<since> - <year>` only when the two differ),
    the document kinds from the directory layout, the tag vocabulary from the documents' front
    matter - so adding an article never reads as a regression;
  * the whole-tree "the site came back byte for byte" checks **attribute** every difference: paths
    this run named must be restored, and anything else that moved is reported as an outside write
    (`⚠️`) instead of failing the run.
