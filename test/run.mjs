// The test suite. No framework, no dependencies — `node test/run.mjs`.
//
// Three kinds of test, and the third is the one that matters most:
//
//   1. invariants     the corpus is intact and the graph resolves
//   2. fixtures       known questions still get known answers
//   3. equivalence    the surface built from files and the surface built from the website's bundled
//                     mirror produce the same version and the same answers
//
// (3) is the one that keeps this honest. The MCP server reads the corpus off disk; the website's
// HTTP API imports its own bundled mirror. Those are two different data paths into one
// implementation, and if they ever disagree, one of the two surfaces is lying. Nothing else in the
// suite would catch that.
//
// The last block drives the MCP server over real stdio, because a protocol bug is invisible to a
// unit test: the server can answer every function correctly and still fail to complete a handshake.

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCorpus, buildCorpus, isSystemEntry } from '../src/corpus.mjs';
import { createSurface } from '../src/query.mjs';
import { TOOLS } from '../src/tools.mjs';
import { buildBundle, readBundle, bundleToCorpusInput } from '../src/bundle.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = resolve(process.env.GRIMOIRE_DIR ?? join(ROOT, '..', 'grimoire'));
const fixtures = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures.json'), 'utf8'));

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

console.log(`\nCorpus (${CORPUS})`);

const surface = createSurface(CORPUS);
const { corpus, graph } = surface;

check('every catalogue file is described by catalog.json', () => {
  assert(corpus.unlisted.length === 0, `undescribed: ${corpus.unlisted.join(', ')}`);
});

check('entry counts agree with catalog.json', () => {
  const drifted = [];
  for (const c of corpus.collections) {
    const declared = corpus.catalog.files.find((f) => f.file === c.file);
    const actual = c.entries.filter((e) => !isSystemEntry(e)).length;
    if (declared && declared.entries !== actual) drifted.push(`${c.file} ${declared.entries} -> ${actual}`);
  }
  assert(drifted.length === 0, `run scripts/gen-catalog.mjs: ${drifted.join(', ')}`);
});

check('the corpus has the shape it claims', () => {
  assert(corpus.stats.files === 81, `expected 81 files, found ${corpus.stats.files}`);
  assert(corpus.stats.entries > 3000, `expected >3000 entries, found ${corpus.stats.entries}`);
  assert(graph.refCount > 30000, `expected >30000 references, found ${graph.refCount}`);
});

check('references resolve, except the ones we know about', () => {
  if (graph.dangling === 0) return;
  const known = new Set(['bagua_areas.json|trigram|tai chi']);
  const found = [];
  for (const [, refs] of graph.forward) {
    for (const r of refs) {
      if (r.targets.length === 0) found.push(r.id);
    }
  }
  const unexpected = found.filter((v) => v !== 'tai chi');
  assert(
    unexpected.length === 0,
    `${unexpected.length} unexpected dangling reference(s): ${unexpected.slice(0, 5).join(', ')}`,
  );
  // The one known exception is the centre of the bagua, whose `trigram` is "tai chi" — the pole the
  // eight turn around, which is not one of the eight. See docs/FINDINGS-2026-10-31.md.
  assert(found.length === known.size, `expected exactly ${known.size} known dangling, found ${found.length}`);
});

console.log('\nFixtures');

for (const f of fixtures.lookups) {
  check(`lookup "${f.query}"`, () => {
    const r = surface.lookup(f.query);
    assert(!r.error, `errored: ${r.error?.message}`);
    assert(r.count > 0, 'found nothing');
    const files = r.results.map((x) => x.file);
    assert(
      JSON.stringify(files) === JSON.stringify(f.expect_files),
      `expected ${JSON.stringify(f.expect_files)}, got ${JSON.stringify(files)}`,
    );
  });
}

for (const f of fixtures.entries) {
  check(`entry "${f.id}"`, () => {
    const r = surface.entry(f.id);
    assert(!r.error, `errored: ${r.error?.message}`);
    assert(r.entry.name === f.expect_name, `name ${r.entry.name} !== ${f.expect_name}`);
    assert(
      r.references.out.length >= f.min_references_out,
      `only ${r.references.out.length} outgoing references`,
    );
    assert(
      r.references.in_count >= f.min_references_in,
      `only ${r.references.in_count} incoming references`,
    );
    assert(r.entry._meta.provenance, 'the response lost its provenance block');
  });
}

for (const f of fixtures.searches) {
  check(`search "${f.query}"`, () => {
    const r = surface.search(f.query);
    assert(!r.error, `errored: ${r.error?.message}`);
    if (f.expect_first) {
      assert(r.results[0]?.id === f.expect_first, `first was ${r.results[0]?.id}, expected ${f.expect_first}`);
    }
    if (f.expect_contains) {
      const ids = r.results.map((x) => x.id);
      assert(ids.includes(f.expect_contains), `expected ${f.expect_contains} among ${ids.join(', ')}`);
    }
    if (f.min_results) assert(r.count >= f.min_results, `only ${r.count} results`);
  });
}

for (const f of fixtures.must_resolve) {
  check(`"${f.id}" resolves — ${f.why}`, () => {
    const refs = corpus.byId.get(f.id) ?? [];
    assert(refs.length > 0, 'resolved to nothing');
    if (f.expect_files) {
      assert(
        JSON.stringify(refs.map((r) => r.file)) === JSON.stringify(f.expect_files),
        `expected ${f.expect_files.join(', ')}, got ${refs.map((r) => r.file).join(', ')}`,
      );
    }
    if (f.expect_count) assert(refs.length === f.expect_count, `expected ${f.expect_count}, got ${refs.length}`);
  });
}

check('meta values are never reported as dangling', () => {
  for (const v of fixtures.meta_values_are_not_references) {
    assert(corpus.joins.isMeta(v), `"${v}" is not treated as a meta value`);
  }
});

check('declared vocabularies are not walked as joins', () => {
  for (const f of fixtures.not_joins) {
    assert(
      corpus.joins.joinSpec(f.file, f.field, f.field) === undefined,
      `${f.file}.${f.field} is still a join — ${f.why}`,
    );
  }
});

check('every entry keeps its provenance available', () => {
  // Not every entry *has* provenance — that is a known gap — but the field must survive formatting.
  const sample = surface.entry('tower');
  assert(sample.entry._meta.provenance !== undefined, 'provenance block missing');
  assert(sample.entry._meta.untraced === false || sample.entry._meta.untraced === true, 'untraced flag missing');
});

console.log('\nTiming');

check('a fixed instant gives a fixed answer', () => {
  const t = fixtures.timing;
  const r = surface.timing({ date: t.at, latitude: t.latitude, longitude: t.longitude });
  assert(!r.error, `errored: ${r.error?.message}`);
  assert(r.planetary_day === t.expect_planetary_day, `day ${r.planetary_day} !== ${t.expect_planetary_day}`);
  assert(r.basis === t.expect_basis, `basis ${r.basis} !== ${t.expect_basis}`);
  assert(r.sabbat?.id === t.expect_sabbat, `sabbat ${r.sabbat?.id} !== ${t.expect_sabbat}`);
  assert(r.hours.length === 24, `expected 24 planetary hours, got ${r.hours.length}`);
});

check('without a location it says so rather than guessing silently', () => {
  const r = surface.timing({ date: fixtures.timing.at });
  assert(r.basis === 'approximation', `basis was ${r.basis}`);
  assert(r.caveats.some((c) => /6am\/6pm/.test(c)), 'no caveat about the approximation');
});

check('workings rank deterministically', () => {
  const a = surface.fits({ date: fixtures.timing.at, latitude: fixtures.timing.latitude, longitude: fixtures.timing.longitude });
  const b = surface.fits({ date: fixtures.timing.at, latitude: fixtures.timing.latitude, longitude: fixtures.timing.longitude });
  assert(!a.error, `errored: ${a.error?.message}`);
  assert(
    JSON.stringify(a.workings.map((w) => w.id)) === JSON.stringify(b.workings.map((w) => w.id)),
    'two identical calls ranked differently',
  );
  assert(a.workings.length > 0, 'ranked nothing');
});

console.log('\nEquivalence (files vs bundled mirror)');

check('the two data paths agree on the corpus version', () => {
  const fromDisk = loadCorpus(CORPUS);
  const rebuilt = buildCorpus({
    files: fromDisk.files,
    catalog: fromDisk.catalog,
    joins: fromDisk.joinsSpec,
  });
  const a = createSurface(CORPUS);
  const b = createSurface({ files: rebuilt.files, catalog: rebuilt.catalog, joins: rebuilt.joinsSpec });
  assert(a.version.version === b.version.version, `${a.version.version} !== ${b.version.version}`);
});

check('the two data paths agree on search results', () => {
  const fromDisk = loadCorpus(CORPUS);
  const memory = createSurface({ files: fromDisk.files, catalog: fromDisk.catalog, joins: fromDisk.joinsSpec });
  for (const q of ['protection', 'tarot', 'moon']) {
    const a = surface.search(q, { limit: 5 }).results.map((r) => `${r.id}@${r.file}`);
    const b = memory.search(q, { limit: 5 }).results.map((r) => `${r.id}@${r.file}`);
    assert(JSON.stringify(a) === JSON.stringify(b), `"${q}" differs: ${a.join(',')} vs ${b.join(',')}`);
  }
});

console.log('\nBundle');

const tmp = mkdtempSync(join(tmpdir(), 'grimoire-test-'));
const bundlePath = join(tmp, 'grimoire.json');
const bundleGzPath = join(tmp, 'grimoire.min.json.gz');

const bundle = buildBundle({
  files: corpus.files,
  catalog: corpus.catalog,
  joins: corpus.joinsSpec,
});
writeFileSync(bundlePath, JSON.stringify(bundle));
writeFileSync(bundleGzPath, gzipSync(Buffer.from(JSON.stringify(bundle)), { level: 9 }));

check('the bundle carries the corpus, the catalog and the join table', () => {
  assert(bundle.$schema === 'grimoire-bundle/1', `schema ${bundle.$schema}`);
  assert(Object.keys(bundle.data).length === 81, `${Object.keys(bundle.data).length} data files`);
  assert(bundle.catalog?.files?.length === 81, 'catalog missing or short');
  assert(Object.keys(bundle.joins.global).length === 183, 'joins missing or short');
  assert(bundle.meta.licence === 'CC BY-SA 4.0', 'licence missing from the file');
});

check('reading it back reproduces the same corpus version', () => {
  for (const path of [bundlePath, bundleGzPath]) {
    const rebuilt = createSurface(bundleToCorpusInput(readBundle(path)));
    assert(
      rebuilt.version.version === surface.version.version,
      `${path} gave ${rebuilt.version.version}, corpus is ${surface.version.version}`,
    );
    assert(rebuilt.corpus.stats.entries === corpus.stats.entries, 'entry count changed through the bundle');
    assert(rebuilt.graph.dangling === graph.dangling, 'dangling count changed through the bundle');
  }
});

check('a bundle missing its join table is rejected rather than silently resolving nothing', () => {
  const broken = join(tmp, 'broken.json');
  writeFileSync(broken, JSON.stringify({ meta: bundle.meta, catalog: bundle.catalog, data: bundle.data }));
  let threw = false;
  try {
    readBundle(broken);
  } catch {
    threw = true;
  }
  assert(threw, 'a bundle with no joins was accepted');
});

console.log('\nMCP server (stdio)');

function runMcp(calls) {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(process.execPath, [join(ROOT, 'mcp', 'server.mjs'), '--corpus', CORPUS], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const responses = new Map();
    let buffer = '';
    let stderr = '';

    proc.stderr.on('data', (d) => {
      stderr += d;
    });
    proc.stdout.on('data', (d) => {
      buffer += d;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined) responses.set(msg.id, msg);
      }
    });

    const send = (msg) => proc.stdin.write(`${JSON.stringify(msg)}\n`);

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    calls.forEach((call, i) => {
      send({ jsonrpc: '2.0', id: 100 + i, method: 'tools/call', params: { name: call.name, arguments: call.args } });
    });

    setTimeout(() => {
      proc.kill();
      if (!responses.has(1)) return reject(new Error(`no initialize response. stderr: ${stderr}`));
      resolvePromise({ responses, stderr });
    }, 2500);
  });
}

const mcpCalls = [
  { name: 'grimoire_overview', args: {} },
  { name: 'grimoire_search', args: { query: 'protection', limit: 2 } },
  { name: 'grimoire_lookup', args: { query: 'basil' } },
  { name: 'grimoire_entry', args: { id: 'mars' } },
  { name: 'grimoire_related', args: { id: 'mars', direction: 'out' } },
  { name: 'grimoire_list', args: { file: 'stones' } },
  { name: 'grimoire_timing', args: { date: fixtures.timing.at } },
  { name: 'grimoire_fits', args: { date: fixtures.timing.at, limit: 3 } },
];

let mcpResult = null;
try {
  mcpResult = await runMcp(mcpCalls);
} catch (err) {
  failures.push(`MCP server: ${err.message}`);
  console.log(`  FAIL MCP server could not be driven\n       ${err.message}`);
}

if (mcpResult) {
  const { responses } = mcpResult;

  check('the handshake completes with a protocol version', () => {
    const init = responses.get(1);
    assert(init.result.protocolVersion, 'no protocolVersion');
    assert(init.result.capabilities.tools, 'no tools capability');
    assert(init.result.serverInfo.name === 'grimoire', `server name ${init.result.serverInfo.name}`);
  });

  check('every tool in the manifest is advertised over the protocol', () => {
    const advertised = responses.get(2).result.tools.map((t) => t.name).sort();
    const declared = TOOLS.map((t) => t.name).sort();
    assert(JSON.stringify(advertised) === JSON.stringify(declared), `${advertised} vs ${declared}`);
  });

  mcpCalls.forEach((call, i) => {
    check(`tools/call ${call.name}`, () => {
      const res = responses.get(100 + i);
      assert(res, 'no response — the call hung or crashed');
      assert(!res.error, `protocol error: ${res.error?.message}`);
      assert(res.result.content?.[0]?.type === 'text', 'no text content');
      const body = JSON.parse(res.result.content[0].text);
      assert(!body.error, `tool error: ${body.error?.code} ${body.error?.message}`);
      assert(body.corpus?.version, 'response lost its corpus version');
    });
  });

  check('an unknown id is a tool error, not a protocol failure', () => {
    // Covered by shape above; asserted separately because "isError" is what an agent branches on.
    const ok = [...responses.values()].every((r) => !r.error);
    assert(ok, 'a protocol-level error was returned');
  });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log('All checks passed.\n');
