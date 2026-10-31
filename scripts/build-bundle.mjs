// Build the downloadable bundle.
//
// This is the most durable thing the surface produces: a single file containing the whole corpus
// plus the table that says how it joins together, so that someone who never wants to run a server,
// an MCP client or this repo can still have the data and know how to read it. 5 MB of JSON, 1.1 MB
// gzipped, and it does not rot.
//
// What goes in it, and why:
//   meta      which corpus this is (content hash), how big, and the licence — an unattributed copy
//             of this file is a licence violation, so the attribution travels inside it
//   catalog   what each file is called and which section it belongs to
//   joins     the reference table — without it, a consumer's only option is guessing from field
//             names, which is the mistake this corpus has paid for three times
//   data      the 81 files, verbatim
//
//   node scripts/build-bundle.mjs

import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBundle } from '../src/bundle.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};

const corpus = resolve(argOf('--corpus') ?? process.env.GRIMOIRE_DIR ?? resolve(ROOT, '..', 'grimoire'));
const outDir = resolve(argOf('--out') ?? join(ROOT, 'dist'));

const META = new Set(['joins.json', 'catalog.json']);
const files = readdirSync(corpus)
  .filter((f) => f.endsWith('.json') && !META.has(f))
  .sort();

const data = {};
for (const f of files) data[f] = JSON.parse(readFileSync(join(corpus, f), 'utf8'));
const joins = JSON.parse(readFileSync(join(corpus, 'joins.json'), 'utf8'));
const catalog = JSON.parse(readFileSync(join(corpus, 'catalog.json'), 'utf8'));

const bundle = buildBundle({ files: data, catalog, joins });

mkdirSync(outDir, { recursive: true });

const full = `${JSON.stringify(bundle, null, 2)}\n`;
const min = JSON.stringify(bundle);
const gz = gzipSync(Buffer.from(min), { level: 9 });

writeFileSync(join(outDir, 'grimoire.json'), full);
writeFileSync(join(outDir, 'grimoire.min.json'), min);
writeFileSync(join(outDir, 'grimoire.min.json.gz'), gz);

const sha = createHash('sha256').update(gz).digest('hex');
writeFileSync(
  join(outDir, 'SHA256SUMS'),
  `${sha}  grimoire.min.json.gz\n${createHash('sha256').update(full).digest('hex')}  grimoire.json\n`,
);

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(`corpus ${bundle.meta.corpus} · ${files.length} files · ${bundle.meta.entries} entries`);
console.log(`  grimoire.json         ${kb(statSync(join(outDir, 'grimoire.json')).size)}`);
console.log(`  grimoire.min.json     ${kb(statSync(join(outDir, 'grimoire.min.json')).size)}`);
console.log(`  grimoire.min.json.gz  ${kb(gz.length)}`);
console.log(`  sha256 ${sha.slice(0, 16)}…`);
