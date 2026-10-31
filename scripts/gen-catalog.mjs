// Keep `grimoire/catalog.json` honest.
//
// The catalog is the corpus's own description of itself: what each file is called, which section it
// is browsed under, and how many entries it holds. It is authored data — the titles and sections
// are editorial — but the *counts* are measurements, and measurements rot the moment someone adds
// an entry. The corpus's own history is the warning: it claimed 36 files while holding 81, and
// claimed 3,085 entries after a pass had deleted two.
//
// So this script refreshes the counts and leaves everything else alone:
//
//   node scripts/gen-catalog.mjs            # refresh counts
//   node scripts/gen-catalog.mjs --check    # fail if any count is wrong or a file is undescribed

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const check = argv.includes('--check');
const argOf = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};

const corpus = resolve(argOf('--corpus') ?? process.env.GRIMOIRE_DIR ?? resolve(ROOT, '..', 'grimoire'));
const catalogPath = join(corpus, 'catalog.json');
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));

const META = new Set(['joins.json', 'catalog.json']);
const files = readdirSync(corpus)
  .filter((f) => f.endsWith('.json') && !META.has(f))
  .sort();

const isSystem = (e) => {
  const type = String(e?.type ?? '');
  if (type === 'system_definition' || type === 'overview' || type === 'reference') return true;
  const id = String(e?.id ?? '');
  return id.endsWith('_system') || id.endsWith('_reference') || id.endsWith('_overview');
};

const measured = new Map();
for (const file of files) {
  const raw = JSON.parse(readFileSync(join(corpus, file), 'utf8'));
  const entries = (Array.isArray(raw) ? raw : []).filter(
    (e) => e && typeof e === 'object' && typeof e.id === 'string',
  );
  measured.set(file, {
    entries: entries.filter((e) => !isSystem(e)).length,
    system_entries: entries.filter(isSystem).length,
  });
}

const problems = [];
const described = new Set(catalog.files.map((f) => f.file));

for (const file of files) {
  if (!described.has(file)) problems.push(`undescribed file: ${file}`);
}
for (const f of catalog.files) {
  if (!measured.has(f.file)) {
    problems.push(`catalog describes a file that does not exist: ${f.file}`);
    continue;
  }
  const m = measured.get(f.file);
  if (f.entries !== m.entries) problems.push(`${f.file}: entries ${f.entries} -> ${m.entries}`);
  if (f.system_entries !== m.system_entries) {
    problems.push(`${f.file}: system_entries ${f.system_entries} -> ${m.system_entries}`);
  }
}

if (check) {
  if (problems.length) {
    console.error('catalog.json is out of date:\n  ' + problems.join('\n  '));
    console.error('\nRefresh with: node scripts/gen-catalog.mjs');
    process.exit(1);
  }
  const total = catalog.files.reduce((n, f) => n + f.entries, 0);
  console.log(`catalog.json is accurate: ${catalog.files.length} files, ${total} entries.`);
} else {
  for (const f of catalog.files) {
    const m = measured.get(f.file);
    if (m) {
      f.entries = m.entries;
      f.system_entries = m.system_entries;
    }
  }
  writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  const total = catalog.files.reduce((n, f) => n + f.entries, 0);
  console.log(`wrote ${catalogPath}`);
  console.log(`  ${catalog.files.length} files, ${total} entries${problems.length ? ` (${problems.length} problems)` : ''}`);
  if (problems.length) console.log('  ' + problems.join('\n  '));
}
