# Test fixtures

Everything under `test/fixtures/` belongs to the test suite. **No test may take its data from
the user's own site** (`/projects/site/content`, `config`, `static`, `assets`): the editor is in
real use, so that content changes for reasons that have nothing to do with whether the editor
works - articles get deleted, drafts appear, tags get renamed. A test that reads it is testing
the user's writing habits, and it breaks the first time the user cleans house.

The rule the suite follows instead:

> A test declares the data it needs. The editor is what is under test.

## `site/` - the fixture corpus

A small, complete Hugo site (20 Markdown files, 5 tiny binary resources, 6 config files). It is
deliberately *not* a copy of the real site: it is the minimum that exercises the contract, and
its names say what they are for.

```
site/
├── config/_default/          hugo.toml, languages.toml (zh default + en), menu.toml,
│                             markup.toml, params.toml, related.toml
├── content/
│   ├── _index.md, _index.en.md          the home page (kind: other)
│   ├── post/
│   │   ├── fixture-article.md|.en.md     standalone article, both languages
│   │   ├── fixture-second.md|.en.md      a second standalone (A/B edits, rename/merge)
│   │   ├── fixture-draft.md              draft: true
│   │   ├── fixture-markdown/             leaf bundle with a code block and a list
│   │   └── fixture-bundle/               leaf bundle owning fixture-photo.jpg (referenced)
│   │                                     and fixture-extra.png (unreferenced)
│   ├── page/                             branch bundle: _index.md, about/, links/
│   │                                     links/ owns fixture-logo.jpg and uses it from a link
│   ├── categories/fixture-category/      taxonomy term page + fixture-banner.png
│   ├── tags/fixture-tag/_index.md        a tag metadata page
│   └── misc/fixture-note.md              a section the editor does not know: kind "other"
├── assets/scss/custom.scss               the site assets tree
└── static/img/logo.png                   the site static tree
```

What the corpus covers on purpose:

| Contract                        | Where it comes from in the fixture                                |
| ------------------------------- | ----------------------------------------------------------------- |
| kinds: article/page/category/other | `post/`, `page/`, `categories/`, `_index.md` + `misc/`         |
| bundle forms: standalone/leaf/branch | `fixture-article.md`, `fixture-bundle/`, `page/`, `categories/` |
| languages                       | every article has a `.md` + `.en.md` sibling                      |
| tag spellings that collide      | `fixture` (many) vs `Fixture` (`fixture-second.en.md`)            |
| a tag used in two languages     | `alpha` in `fixture-article.md` and `fixture-article.en.md`       |
| links list: item/field indentation, external + resource image | `page/links/index.md`             |
| list indentation both ways      | `fixture-article.en.md` (2 spaces), `fixture-second.md` (4 spaces) |
| resources: referenced/unreferenced, content/static/assets trees | `fixture-bundle/`, `static/`, `assets/` |
| trash, delete scopes, moves     | the whole tree: nothing is special-cased                          |

`harness.js` is the only module that knows these paths. `FIXTURE` names each document once
(`FIXTURE.article`, `FIXTURE.bundle`, `FIXTURE.links`, ...) and `makeFixtureSandbox(t)` hands a
test a writable copy in a temp directory.

## Adding a fixture

* Add the file to `site/` when the *shape* matters to more than one test (a new bundle form, a
  new front-matter field). Give it a name that says what it is, then add it to `FIXTURE` in
  `harness.js`.
* Write it in the test when only that test needs it (a temporary tag page, a change set, an
  upload). Prefer writing to a sandbox copy over adding a file here.
* Never add a fixture that duplicates the user's content "so the test keeps passing": if an
  assertion only holds because of a particular article, that assertion belongs to a fixture.

## What still touches the real site

One file does, on purpose:

* **`scripts/acceptance.mjs`** (`npm run accept`) - the smoke run against the running editor and a
  real Hugo build. It is the only place that exercises *the user's own site*: it writes the real
  tree through the API, restores every byte it touched, and hashes the tree before and after.
  It is red as of 2026-09-30 because it still names documents the user has deleted since; see
  `AGENTS.md`, "Phase Insert C", for the two ways out.

And one assertion inside the suite:

* **`test/acceptance.test.js`**, last test - the editor's build outputs and backups must live
  outside the site Hugo builds. That is a statement about the real deployment and cannot be made
  against a fixture. Everything else in that file sweeps the fixture corpus (20 documents, 9 of
  them writable) and proves the corpus is byte-identical afterwards.
