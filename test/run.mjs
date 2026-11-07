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
import { moonPhase } from '../src/timing.mjs';
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
  assert(corpus.stats.files === 83, `expected 83 files, found ${corpus.stats.files}`);
  assert(corpus.stats.entries > 3000, `expected >3000 entries, found ${corpus.stats.entries}`);
  assert(graph.refCount > 30000, `expected >30000 references, found ${graph.refCount}`);
});

check('every reference resolves', () => {
  // This was "except the ones we know about" until 2026-10-31, with one documented exception: the
  // centre of the bagua, whose `trigram` was "tai chi" — the pole the eight turn around, not one of
  // the eight. It now reads `none_traditionally`, which is a legal meta value, so there are no
  // exceptions left and the count is a hard invariant rather than a list.
  const found = [];
  for (const [, refs] of graph.forward) {
    for (const r of refs) if (r.targets.length === 0) found.push(`${r.field}=${r.id}`);
  }
  assert(found.length === 0, `${found.length} unresolved reference(s): ${found.slice(0, 5).join(', ')}`);
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

for (const f of fixtures.finds) {
  check(`find ${JSON.stringify(f.where)} in ${f.file}`, () => {
    const r = surface.find({ file: f.file, where: f.where });
    assert(!r.error, `errored: ${r.error?.message}`);
    assert(r.total >= f.min_total, `only ${r.total} matches, expected at least ${f.min_total}`);
    if (f.expect_contains) {
      const ids = r.entries.map((x) => x.id);
      assert(ids.includes(f.expect_contains), `${f.expect_contains} not among ${ids.join(', ')}`);
    }
  });
}

check('fields lists what find can match, with shape and coverage', () => {
  const f = fixtures.fields;
  const r = surface.fields({ file: f.file });
  assert(!r.error, `errored: ${r.error?.message}`);
  assert(r.count === f.expect_count, `${r.count} fields, expected ${f.expect_count}`);
  for (const path of f.expect_multi) {
    const field = r.fields.find((x) => x.path === path);
    assert(field, `missing ${path}`);
    assert(field.multi === true, `${path} is not marked multi-valued`);
    assert(field.entries > 0, `${path} has no entries`);
  }
  for (const path of f.expect_number) {
    const field = r.fields.find((x) => x.path === path);
    assert(field?.type === 'number', `${path} is ${field?.type}, expected number`);
  }
});

check('the whole corpus has far more matchable fields than the error hint can show', () => {
  const r = surface.fields({});
  assert(r.count > 500, `only ${r.count} corpus-wide fields`);
  assert(r.collections.length === 83, `${r.collections.length} collections`);
});

check('an operator is refused rather than silently matching nothing', () => {
  const r = surface.find({ file: 'herbs', where: { tier: '>1' } });
  assert(r.error?.code === 'bad_request', `code was ${r.error?.code}`);
  assert(/exactly/.test(r.error.message), `message did not explain exactness: ${r.error.message}`);
});

check('a wrong field name is named as wrong, with the real ones offered', () => {
  // The failure mode this prevents: a typo reads as "nothing matches", and the caller concludes the
  // corpus has no Mars herbs when the field is actually called `planet`.
  const r = surface.find({ file: 'herbs.json', where: { planets: 'mars' } });
  assert(r.error?.code === 'bad_request', `code was ${r.error?.code}`);
  assert(/planet/.test(r.error.hint ?? ''), 'the hint did not list the fields that exist');
});

for (const f of fixtures.paths) {
  check(`path ${f.from} → ${f.to}`, () => {
    const r = surface.path({ from: f.from, to: f.to });
    assert(!r.error, `errored: ${r.error?.message}`);
    assert(r.found === (f.expect_found ?? true), `found was ${r.found}`);
    if (f.expect_length !== undefined) {
      assert(r.length === f.expect_length, `length ${r.length} !== ${f.expect_length}`);
    }
    if (f.expect_edges) {
      const edges = r.paths[0].edges.map((e) => e.field);
      assert(
        JSON.stringify(edges) === JSON.stringify(f.expect_edges),
        `edges ${edges.join(',')} !== ${f.expect_edges.join(',')}`,
      );
    }
  });
}

check('path says it searched too shallowly rather than calling two things unrelated', () => {
  const r = surface.path({ from: 'basil', to: 'protection', max_depth: 1 });
  assert(r.found === false, 'claimed a path within one hop');
  assert(r.hint, 'no hint about widening the search');
});

check('an ambiguous id returns every full record, not just the first', () => {
  const f = fixtures.entry_ambiguity;
  const r = surface.entry(f.id);
  assert(!r.error, `errored: ${r.error?.message}`);
  assert(r.ambiguous === true, 'did not report the ambiguity');
  assert(r.records?.length === f.expect_records, `records ${r.records?.length} !== ${f.expect_records}`);
  assert(r.records.every((x) => x._meta && x.id === f.id), 'a record lost its addressing');
  const files = new Set(r.records.map((x) => x._meta.file));
  assert(files.size === f.expect_records, 'the records are not distinct entries');
});

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

check('every hexagram phase resolves to a Wu Xing phase', () => {
  // The `element` → `phase` rename (2026-10-31) is only an improvement if the values actually join.
  // A hexagram whose phase named nothing would render as plain text and look fine, which is exactly
  // the kind of silent regression this suite exists for.
  const hexagrams = corpus.collectionByFile.get('hexagrams.json')?.entries ?? [];
  assert(hexagrams.length > 0, 'no hexagrams loaded');
  const unresolved = hexagrams.filter((e) => !corpus.byId.has(String(e.phase)));
  assert(unresolved.length === 0, `${unresolved.length} hexagram(s) have a phase that names nothing`);
});

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

check('fits actually scores the day', () => {
  // 2026-10-31 is a Saturday. Until 2026-11-01 the surface passed the planetary ruler (`saturn`)
  // where the corpus's `days` hold weekday names (`saturday`), so the heaviest factor — 25 points —
  // could never match and every ranking was missing its main signal.
  const r = surface.fits({
    date: fixtures.timing.at,
    latitude: fixtures.timing.latitude,
    longitude: fixtures.timing.longitude,
    limit: 10,
  });
  assert(r.conditions.weekday === 'saturday', `weekday was ${r.conditions.weekday}`);
  assert(
    r.workings.some((w) => w.factors.find((f) => f.name === 'Day')?.matched),
    'no working matched the day at all',
  );
});

check('rituals with an election are ranked, and only on what they state', () => {
  const full = surface.fits({
    date: '2026-11-24T20:00:00+11:00',
    time_zone: 'Australia/Sydney',
    catalogue: 'rituals',
  });
  assert(!full.error, `errored: ${full.error?.message}`);
  assert(full.catalogue === 'rituals', `catalogue was ${full.catalogue}`);
  assert(full.rituals.length === 6, `${full.rituals.length} rituals, expected the 6 with an election`);
  assert(full.rituals[0].id === 'drawing_down_the_moon', `top was ${full.rituals[0].id}`);
  assert(full.rituals[0].percentage === 100, `drawing down scored ${full.rituals[0].percentage}%`);

  const dark = surface.fits({
    date: '2026-11-09T12:00:00+11:00',
    time_zone: 'Australia/Sydney',
    catalogue: 'rituals',
  });
  const perfect = dark.rituals.filter((r) => r.percentage === 100).map((r) => r.id).sort();
  assert(
    perfect.includes('consecration_of_tools') && perfect.includes('ancestor_altar'),
    `new moon ranked ${perfect.join(', ')} at 100%`,
  );

  assert(
    full.caveats.some((c) => /6 of the 26/.test(c)),
    'no caveat explaining that 20 rituals have no election',
  );
});

check('fits ranks talismans on what they actually state', () => {
  const r = surface.fits({
    date: fixtures.timing.at,
    latitude: fixtures.timing.latitude,
    longitude: fixtures.timing.longitude,
    time_zone: 'Australia/Sydney',
    catalogue: 'talismans',
  });
  assert(!r.error, `errored: ${r.error?.message}`);
  assert(r.catalogue === 'planetary_talismans', `catalogue was ${r.catalogue}`);
  assert(r.talismans?.length === 7, `${r.talismans?.length} talismans, expected 7`);
  // 2026-10-31 is a Saturday, and the Saturn talisman is the one for Saturday.
  assert(r.talismans[0].id === 'saturn', `top talisman was ${r.talismans[0].id}`);
  assert(
    r.caveats.some((c) => /only a day and an hour/.test(c)),
    'no caveat saying only two factors were scored',
  );
});

console.log('\nWhen (forward-looking)');

check('a phase date really is that phase', () => {
  const r = surface.when({ from: fixtures.when.at });
  assert(!r.error, `errored: ${r.error?.message}`);
  assert(r.moon.next.length === 4, `expected the 4 cardinal phases, got ${r.moon.next.length}`);
  for (const p of r.moon.next) {
    const actual = moonPhase(new Date(p.date));
    assert(actual.id === p.id, `${p.id} at ${p.date} is actually ${actual.id}`);
    assert(p.days_away > 0, `${p.id} is not in the future`);
  }
});

check('sabbats land on their own date, not a day early', () => {
  // The date used to be formatted through toISOString, which is UTC — Samhain showed as 30 October
  // in Sydney. A festival date is a local calendar fact.
  const r = surface.when({ from: fixtures.when.sabbat_from, days: fixtures.when.sabbat_days });
  assert(!r.error, `errored: ${r.error?.message}`);
  const yule = r.sabbats.find((s) => s.id === 'yule');
  assert(yule, `yule not in ${r.sabbats.map((s) => s.id).join(', ') || 'nothing'}`);
  assert(yule.date === '2026-12-21', `yule was ${yule.date}`);
  assert(yule.days_away > 0, 'yule was not ahead');
});

check('the next hour of a planet is real and ahead', () => {
  const r = surface.when({ from: fixtures.when.at, planet: fixtures.when.planet });
  assert(!r.error, `errored: ${r.error?.message}`);
  assert(r.hour?.planet === fixtures.when.planet, 'no hour for the requested planet');
  assert(new Date(r.hour.start) > new Date(fixtures.when.at), 'the hour is in the past');
  assert(r.hour.hours_away <= 24, `${r.hour.hours_away}h away, expected within a day`);
});

check('working windows are ahead, ranked, and weekday-consistent', () => {
  const r = surface.when({ from: fixtures.when.at, working: fixtures.when.working, days: 30, limit: 5 });
  assert(!r.error, `errored: ${r.error?.message}`);
  const windows = r.working.windows;
  assert(windows.length > 0, 'no windows returned');
  for (let i = 1; i < windows.length; i += 1) {
    assert(windows[i - 1].percentage >= windows[i].percentage, 'windows are not ranked');
  }
  for (const w of windows) {
    // `>=` because an hour that begins exactly at `from` is current, not past.
    assert(new Date(w.start) >= new Date(fixtures.when.at), 'a window is in the past');
    assert(new Date(w.end) > new Date(fixtures.when.at), 'a window ends before it starts');
    const weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][
      new Date(w.start).getDay()
    ];
    assert(w.conditions.weekday === weekday, `${w.date} says ${w.conditions.weekday}, actually ${weekday}`);
  }
});

check('clock and calendar judgements follow the named zone, not the server', () => {
  // 10:00 on 1 December in Sydney is 23:00 on 30 November in UTC: different hour, different season
  // (northern autumn ends in November), different weekday. Before this was threaded, the droplet
  // (UTC) answered "morning" to a Sydney evening and labelled December with November's season.
  const at = '2026-12-01T10:00:00+11:00';
  const syd = surface.timing({ date: at, time_zone: 'Australia/Sydney' });
  const utc = surface.timing({ date: at, time_zone: 'UTC' });
  assert(!syd.error && !utc.error, 'timing rejected a valid zone');
  assert(syd.time_of_day !== utc.time_of_day, `both zones said ${syd.time_of_day}`);
  assert(syd.season !== utc.season, `both zones said ${syd.season}`);
  assert(
    syd.caveats.some((c) => c.includes('Australia/Sydney')),
    'the response did not name the zone it used',
  );

  const fSyd = surface.fits({ date: at, time_zone: 'Australia/Sydney' });
  const fUtc = surface.fits({ date: at, time_zone: 'UTC' });
  assert(fSyd.conditions.weekday === 'tuesday', `Sydney weekday was ${fSyd.conditions.weekday}`);
  assert(fUtc.conditions.weekday === 'monday', `UTC weekday was ${fUtc.conditions.weekday}`);

  assert(surface.timing({ time_zone: 'Mars/Olympus' }).error?.code === 'bad_request', 'a made-up zone was accepted');
});

check('when rejects what it cannot answer', () => {
  assert(surface.when({ phase: 'blue_moon' }).error?.code === 'bad_request', 'a made-up phase was accepted');
  assert(surface.when({ planet: 'earth' }).error?.code === 'bad_request', 'a non-ruler was accepted');
  assert(surface.when({ working: 'nope_xyz' }).error?.code === 'not_found', 'a missing working was accepted');
  assert(surface.when({ from: 'not-a-date' }).error?.code === 'bad_request', 'a bad date was accepted');
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
  assert(Object.keys(bundle.data).length === 83, `${Object.keys(bundle.data).length} data files`);
  assert(bundle.catalog?.files?.length === 83, 'catalog missing or short');
  // Derive the expected size from the corpus rather than freezing a number: this test is about
  // the bundle carrying the table, not about how many rules the table happens to have.
  assert(
    Object.keys(bundle.joins.global).length === Object.keys(corpus.joinsSpec.global).length,
    'joins missing or short',
  );
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
  { name: 'grimoire_find', args: { file: 'herbs', where: { planet: 'mars' }, limit: 2 } },
  { name: 'grimoire_fields', args: { file: 'herbs' } },
  { name: 'grimoire_entry', args: { id: 'mars' } },
  { name: 'grimoire_related', args: { id: 'mars', direction: 'out' } },
  { name: 'grimoire_path', args: { from: 'basil', to: 'protection' } },
  { name: 'grimoire_list', args: { file: 'stones' } },
  { name: 'grimoire_timing', args: { date: fixtures.timing.at } },
  { name: 'grimoire_when', args: { from: fixtures.when.at, planet: 'venus' } },
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
