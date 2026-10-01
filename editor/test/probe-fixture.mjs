// Probe: what does the document service report for the fixture corpus?
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { createDocumentService } from '../src/site/documentService.js';
import { FIXTURE_CONTENT, FIXTURE_SITE } from './fixtures/harness.js';

const service = createDocumentService({
  contentRoot: FIXTURE_CONTENT,
  siteRoot: FIXTURE_SITE,
  sections: [''],
  backupRoot: '/tmp/probe-backups',
});

const docs = await service.listDocuments();
console.log('wide documents:', docs.length);
for (const doc of docs) console.log('  ', doc.section || '(root)', doc.kind, doc.language, doc.path);
console.log('sections:', JSON.stringify(await service.listSections()));

const narrow = createDocumentService({
  contentRoot: FIXTURE_CONTENT,
  siteRoot: FIXTURE_SITE,
  section: 'post',
  backupRoot: '/tmp/probe-backups',
});
console.log('narrow post documents:', (await narrow.listDocuments()).length);

let md = 0;
const walk = (dir, base = dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, base);
    else if (entry.name.endsWith('.md')) {
      md += 1;
      const rel = abs.slice(base.length + 1);
      console.log('  md:', rel, rel.includes('/') ? rel.split('/')[0] : '(root)');
    }
  }
};
walk(FIXTURE_CONTENT);
console.log('markdown files:', md);
