// One command that answers "is everything still aligned?"
//
// The corpus feeds four things across two repositories — the website's mirror, its graph, its
// generated join table, and the query surface vendored into it — plus the MCP server and the
// published bundle. Each has its own drift guard, and until now they were four flags in two repos
// that a person had to remember to run. This runs all of them, and adds the two checks nothing else
// made:
//
//   * corpus <-> mirror FILE PARITY. The website's checker iterates the mirror and compares each
//     file to the corpus, which silently passes when a corpus file was never mirrored at all. A new
//     catalogue was invisible to readers and every check stayed green.
//   * the site GRAPH IMPORTS every catalogue. `grimoire-graph.ts` needs a `col()` line per file or
//     the file has no page and no links; nothing tested that.
//
//   node scripts/check-all.mjs
//
// Exit 0 means aligned. Exit 1 prints every guard that failed, so one run tells you what to fix.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = resolve(process.env.GRIMOIRE_DIR ?? join(ROOT, '..', 'grimoire'));
const WEBSITE = resolve(join(ROOT, '..', 'ensoul-public', 'ensoul-web'));

/** Metadata files are the corpus's own description; they are not catalogues of entries. */
const META = new Set(['joins.json', 'catalog.json']);

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `\n         ${detail}` : ''}`);
};

function run(name, cmd, args) {
  try {
    execFileSync(cmd, args, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
    record(name, true);
  } catch (err) {
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim().split('\n').slice(-4).join('\n         ');
    record(name, false, out || err.message);
  }
}

console.log(`\nGrimoire alignment — corpus ${CORPUS}\n`);

run('catalog counts match the corpus', process.execPath, ['scripts/gen-catalog.mjs', '--check']);
run('the website join table is generated from the corpus', process.execPath, ['scripts/gen-joins.mjs', '--check']);
run('the query surface vendored into the website is current', process.execPath, ['scripts/vendor-site.mjs', '--check']);
run('the corpus and its published surfaces pass their tests', process.execPath, ['test/run.mjs']);

// --- corpus <-> mirror file parity -------------------------------------------------------------
const mirrorDir = join(WEBSITE, 'src', 'data', 'grimoire');
if (!existsSync(mirrorDir)) {
  record('every catalogue is mirrored to the website', true, '(skipped: no website checkout beside this repo)');
} else {
  const catalogues = readdirSync(CORPUS).filter((f) => f.endsWith('.json') && !META.has(f)).sort();
  const mirrored = readdirSync(mirrorDir).filter((f) => f.endsWith('.json') && !META.has(f)).sort();

  const missing = catalogues.filter((f) => !mirrored.includes(f));
  const extra = mirrored.filter((f) => !catalogues.includes(f));

  if (missing.length || extra.length) {
    record('every catalogue is mirrored to the website', false, [
      missing.length ? `not mirrored: ${missing.join(', ')}` : '',
      extra.length ? `in the mirror but not the corpus: ${extra.join(', ')}` : '',
    ].filter(Boolean).join('\n         '));
  } else {
    const drift = catalogues.filter(
      (f) => readFileSync(join(CORPUS, f), 'utf8') !== readFileSync(join(mirrorDir, f), 'utf8'),
    );
    record(
      'every catalogue is mirrored to the website',
      drift.length === 0,
      drift.length ? `differs: ${drift.join(', ')}` : '',
    );
  }

  // --- the site graph imports every catalogue --------------------------------------------------
  const graphPath = join(WEBSITE, 'src', 'lib', 'grimoire-graph.ts');
  if (!existsSync(graphPath)) {
    record('every catalogue is imported by the website graph', true, '(skipped: no grimoire-graph.ts)');
  } else {
    const graph = readFileSync(graphPath, 'utf8');
    const unimported = catalogues.filter((f) => !graph.includes(`col('${f}'`));
    record(
      'every catalogue is imported by the website graph',
      unimported.length === 0,
      unimported.length ? `no col() line, so no page and no links: ${unimported.join(', ')}` : '',
    );
  }

  // --- the website's own grimoire checks -------------------------------------------------------
  const siteCheck = join(WEBSITE, 'scripts', 'check-grimoire.mjs');
  if (existsSync(siteCheck)) {
    run("the website's own grimoire checks pass", process.execPath, [siteCheck]);
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} aligned, ${failed.length} out of step`);
if (failed.length) {
  console.log('\nTo fix, see docs/CHANGING-THE-CORPUS.md — it maps each surface to the command that updates it.');
  process.exit(1);
}
console.log('Everything agrees.\n');
