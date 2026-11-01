// The query surface: one object with the verbs, shared by the MCP server and the HTTP API.
//
// Both transports call exactly these functions, so the two cannot drift apart in behaviour — a
// difference between them would be a wrong answer on one of the two, and the whole point of having
// both is that the agent and the browser get the same corpus.
//
// The verbs are questions, not table dumps. That is deliberate: `git clone` already gives you the
// tables, and an endpoint that re-serves them is worse than the clone because it can go down. What
// you cannot get from the clone in one step is:
//
//   what is X                 lookup
//   what mentions X           search
//   what holds these values   find       (structured fields, not text)
//   what does X point at      entry      (forward references)
//   what points at X          related    (backlinks — the reverse index)
//   how do X and Y connect    path       (multi-hop, field-labelled)
//   what's in this file       list
//   what is true right now    timing
//   when is the next ...      when       (forward-looking: phases, sabbats, hours, windows)
//   what fits these conditions  fits
//
// Every response carries `corpus.version`, so an answer can always be attributed to a specific
// state of the data.

import { loadCorpus, buildCorpus as buildCorpusFrom, isSystemEntry } from './corpus.mjs';
import { buildGraph, pathBetween } from './graph.mjs';
import { buildSearchIndex, search as runSearch, lookup as runLookup } from './search.mjs';
import { entrySummary, entryFull, edgeOut, edgeIn, provenanceOf, href } from './format.mjs';
import { corpusVersion } from './version.mjs';
import { timingSnapshot, scoreWorkings, dayOfWeek, moonPhase, nextMoonPhase, sabbatsInRange, nextPlanetaryHour, workingWindows, planetaryHours, MOON_PHASES, CHALDEAN_ORDER } from './timing.mjs';

const MAX_LIMIT = 200;

function fail(code, message, hint) {
  return { error: { code, message, ...(hint ? { hint } : {}) } };
}

// --- structured matching (`find`) ---------------------------------------------------------------
//
// `find` answers a different shape of question from `search`: not "what mentions this word" but
// "what holds these values". The corpus is unusually well suited to it — `planet`, `element`,
// `chakra`, `zodiac`, `tradition` and `tier` are clean fields on thousands of entries — and until
// this verb existed the only way to ask was to fetch a whole catalogue and filter it yourself.

/** Every scalar-valued field path in an entry, so an unknown field can be named rather than guessed. */
function collectPaths(node, set, prefix, depth) {
  if (depth > 4) return;
  if (Array.isArray(node)) {
    for (const item of node) collectPaths(item, set, prefix, depth);
    return;
  }
  if (!node || typeof node !== 'object') {
    if (prefix) set.add(prefix);
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') collectPaths(v, set, path, depth + 1);
    else set.add(path);
  }
}

/** The scalar values at a dotted path, flattening arrays at every step. */
function valuesAt(entry, path) {
  let nodes = [entry];
  for (const key of path.split('.')) {
    const next = [];
    for (const n of nodes) {
      if (!n || typeof n !== 'object') continue;
      const v = n[key];
      if (v === undefined) continue;
      if (Array.isArray(v)) next.push(...v);
      else next.push(v);
    }
    nodes = next;
  }
  return nodes.filter((v) => v === null || typeof v !== 'object');
}

/**
 * The forms a value is compared in. The corpus writes ids in snake_case (`new_moon`) and people type
 * the display form (`new moon`), so both are accepted rather than making the caller learn the ids.
 */
function variantsOf(value) {
  const n = String(value ?? '')
    .toLowerCase()
    .trim();
  const out = new Set([n]);
  if (n.includes(' ')) out.add(n.replace(/\s+/g, '_'));
  if (n.includes('_')) out.add(n.replace(/_/g, ' '));
  return out;
}

function clausePasses(entry, path, wanted) {
  const actual = valuesAt(entry, path);
  if (actual.length === 0) return false;
  const actualForms = new Set();
  for (const a of actual) for (const v of variantsOf(a)) actualForms.add(v);
  const wantedList = Array.isArray(wanted) ? wanted : [wanted];
  return wantedList.some((w) => [...variantsOf(w)].some((v) => actualForms.has(v)));
}

export function createSurface(options) {
  // Either a path (the MCP server, reading a checkout) or the already-parsed corpus (the website,
  // which bundles its own mirror and has no checkout at runtime). Same object from here on.
  const corpus =
    typeof options === 'string' || options === undefined
      ? loadCorpus(options)
      : buildCorpusFrom(options);
  const graph = buildGraph(corpus);
  const docs = buildSearchIndex(corpus);
  const version = corpusVersion(corpus.files, corpus.joinsSpec);

  const meta = () => ({
    corpus: {
      version: version.version,
      files: corpus.stats.files,
      entries: corpus.stats.entries,
      licence: version.licence,
      attribution: version.attribution,
    },
  });

  const clamp = (n, fallback = 20) =>
    Math.min(MAX_LIMIT, Math.max(1, Number.isFinite(Number(n)) ? Number(n) : fallback));

  /** What the corpus is: its files, sections, counts and health. */
  function info() {
    return {
      ...meta(),
      name: 'The Grimoire',
      description:
        'A hand-curated corpus of esoteric and metaphysical reference data: one symbolic system per file, every entry addressed by id, every cross-reference resolved.',
      sections: corpus.catalog.sections.map((s) => ({
        key: s.key,
        title: s.title,
        files: corpus.collections.filter((c) => c.section === s.key).length,
      })),
      collections: corpus.collections.map((c) => ({
        file: c.file,
        key: c.key,
        title: c.title,
        section: c.section,
        entries: c.entries.filter((e) => !isSystemEntry(e)).length,
      })),
      stats: {
        ...corpus.stats,
        references: graph.refCount,
        dangling_references: graph.dangling,
      },
      addressing: {
        entry_url: 'https://ensoul.so/grimoire/e/{id}',
        ids_are: 'the `id` field of an entry, unique within its file but not across the corpus',
        note: 'An id may name more than one entry — `sage` is an archetype, a herb and a resin.',
      },
      ...(corpus.unlisted.length
        ? { warning: `Files present but not in catalog.json: ${corpus.unlisted.join(', ')}` }
        : {}),
    };
  }

  /** Resolve a name or id to entries. Reports ambiguity rather than hiding it. */
  function lookup(query, { file, limit = 10 } = {}) {
    if (typeof query !== 'string' || !query.trim()) {
      return fail('bad_request', 'lookup needs a non-empty query (an id, a name, or an alternative name).');
    }
    const found = runLookup(corpus, docs, query, { file, limit: clamp(limit, 10) });
    const distinctFiles = new Set(found.results.map((r) => r.ref.file)).size;
    return {
      ...meta(),
      query,
      matched_by: found.mode,
      count: found.results.length,
      // More than one entry for one id is normal in this corpus, not an error: `basil` is a herb, an
      // essential oil and a resin — the same substance in three forms — while `sage` is three
      // unrelated things that happen to share a name.
      multiple_entries: distinctFiles > 1,
      results: found.results.map((r) => ({ how: r.how, ...entrySummary(r.ref) })),
      ...(distinctFiles > 1
        ? {
            note: 'This id names entries in more than one catalogue. That is normal: a substance and the form it takes share an id, and some names are genuinely shared. Read the `file` on each result.',
          }
        : {}),
    };
  }

  /** Full-text search, weighted so identifiers beat body mentions. */
  function search(query, { file, section, limit = 20 } = {}) {
    if (typeof query !== 'string' || !query.trim()) {
      return fail('bad_request', 'search needs a non-empty query.');
    }
    const found = runSearch(docs, query, { file, section, limit: clamp(limit) });
    return {
      ...meta(),
      query,
      mode: found.mode,
      count: found.results.length,
      results: found.results.map((h) => ({
        score: h.score,
        matched: h.matched,
        ...entrySummary(h.doc.ref),
      })),
      ...(found.results.length === 0
        ? { hint: 'Nothing matched. Try a single word, or browse the collections with the `list` tool.' }
        : {}),
    };
  }

  /**
   * Structured query: entries whose fields hold these values.
   *
   * Deliberately not full-text. `search` ranks by how well text matches; `find` is exact and gives
   * you a count, because "all 142 stones ruled by Venus" is a set query and a relevance ranking
   * would be the wrong shape for it.
   */
  function find({ file, section, where, match = 'all', limit = 50, offset = 0 } = {}) {
    const lim = clamp(limit, 50);
    const off = Math.max(0, Number(offset) || 0);

    if (where === null || typeof where !== 'object' || Array.isArray(where)) {
      return fail(
        'bad_request',
        '`find` needs `where` — an object of field → value, e.g. {"planet":"mars"}.',
        'A value may be an array meaning any-of that field. For text, use `search`.',
      );
    }
    const clauses = Object.entries(where);
    const mode = match === 'any' ? 'any' : 'all';

    const targets = corpus.collections.filter(
      (c) => (!file || c.file === file || c.key === file) && (!section || c.section === section),
    );
    if (targets.length === 0) {
      return fail(
        'not_found',
        `No collection matching \`${file ?? section}\`.`,
        'Call `list` with no arguments to see every collection.',
      );
    }

    // A field name that exists nowhere in scope is a typo, not an empty result. Without this,
    // `{"planets":"mars"}` against a file that calls it `planet` reads as "nothing matches" and the
    // caller has no way to find out what the field is actually called.
    const available = new Set();
    for (const c of targets) {
      for (const e of c.entries) if (!isSystemEntry(e)) collectPaths(e, available, '', 0);
    }
    const known = (key) => [...available].some((p) => p === key || p.startsWith(`${key}.`));
    const unknown = clauses.map(([k]) => k).filter((k) => !known(k));
    if (unknown.length > 0) {
      return fail(
        'bad_request',
        `No field named \`${unknown.join('`, `')}\` in ${file ? `\`${file}\`` : 'this scope'}.`,
        `Fields here include: ${[...available].sort().slice(0, 20).join(', ')}.`,
      );
    }

    const matched = [];
    for (const c of targets) {
      for (const e of c.entries) {
        if (isSystemEntry(e)) continue;
        if (clauses.length > 0) {
          const hits = clauses.map(([k, v]) => clausePasses(e, k, v));
          if (!(mode === 'any' ? hits.some(Boolean) : hits.every(Boolean))) continue;
        }
        matched.push({ entry: e, file: c.file, collection: c, nested: false });
      }
    }

    const page = matched.slice(off, off + lim);
    return {
      ...meta(),
      filters: {
        file: file ?? null,
        section: section ?? null,
        where,
        match: mode,
      },
      total: matched.length,
      offset: off,
      count: page.length,
      entries: page.map((r) => entrySummary(r)),
      ...(off + lim < matched.length ? { next_offset: off + lim } : {}),
      ...(matched.length === 0
        ? {
            hint:
              'No entry holds all of those values together. Try `match: "any"`, drop a field, or call `search` if you meant to match text rather than a field.',
          }
        : {}),
      caveats: [
        '`find` matches the values written in the corpus. It does not follow references — use `related` or `path` for the graph.',
      ],
    };
  }

  /** One entry in full, with its references in both directions. */
  function entry(id, { file } = {}) {
    if (typeof id !== 'string' || !id.trim()) {
      return fail('bad_request', 'entry needs an id, e.g. `basil` or `new_moon`.');
    }
    const refs = (corpus.byId.get(id.trim().toLowerCase()) ?? []).filter(
      (r) => !file || r.file === file || r.collection.key === file,
    );
    if (refs.length === 0) {
      const near = runSearch(docs, id, { limit: 5 });
      return fail(
        'not_found',
        `No entry with the id \`${id}\`.`,
        near.results.length
          ? `Did you mean: ${near.results.map((h) => h.doc.ref.entry.id).join(', ')}?`
          : 'Use the `search` tool to find the entry first.',
      );
    }

    const primary = refs[0];
    const forward = graph.forwardRefs(primary.entry);
    const back = graph.backlinks(primary.entry.id);

    // An id shared by four catalogues is four different things, and returning only the first in full
    // made the tool unable to answer the ambiguity it had just detected — `sage` is an archetype, a
    // herb, a resin and an oil, and you had to call `entry` four times with `file` to see them. The
    // primary record stays where it was so existing consumers keep working; `records` is every one.
    const records =
      refs.length > 1
        ? refs.map((r, i) =>
            entryFull(r, i === 0 ? { forward, back } : { forward: graph.forwardRefs(r.entry), back: graph.backlinks(r.entry.id) }),
          )
        : undefined;

    return {
      ...meta(),
      ambiguous: refs.length > 1,
      ...(refs.length > 1
        ? {
            also_in: refs.slice(1).map((r) => ({ file: r.file, collection: r.collection.key })),
            records_count: refs.length,
            records,
            note: 'This id names more than one entry, and each is a different thing rather than a duplicate. `entry` is the first; `records` holds all of them in full, each with its own references.',
          }
        : {}),
      entry: entryFull(primary, { forward, back }),
      references: {
        out: forward.map((f) => edgeOut(corpus, f)),
        in_count: back.length,
        in: back.slice(0, 50).map((l) => edgeIn(corpus, l)),
        ...(back.length > 50 ? { in_truncated: back.length - 50 } : {}),
      },
    };
  }

  /**
   * The neighbourhood of an entry: what it points at and what points at it, grouped by field.
   * This is the verb the corpus could not offer before the graph existed.
   */
  function related(id, { direction = 'both', limit = 100 } = {}) {
    const refs = corpus.byId.get(String(id).trim().toLowerCase()) ?? [];
    if (refs.length === 0) {
      return fail('not_found', `No entry with the id \`${id}\`.`, 'Use `search` to find it first.');
    }
    const want = direction === 'out' || direction === 'in' ? direction : 'both';
    const out = new Map();
    const inn = new Map();

    for (const ref of refs) {
      if (want !== 'in') {
        for (const f of graph.forwardRefs(ref.entry)) {
          const list = out.get(f.field) ?? [];
          list.push({ id: f.id, resolves: f.targets.length > 0, targets: f.targets.map((t) => entrySummary(t)) });
          out.set(f.field, list);
        }
      }
      if (want !== 'out') {
        for (const l of graph.backlinks(ref.entry.id)) {
          const list = inn.get(l.field) ?? [];
          list.push({ file: l.file, ...entrySummary({ entry: l.entry, file: l.file, collection: corpus.collectionByFile.get(l.file), nested: false }) });
          inn.set(l.field, list);
        }
      }
    }

    const trim = (m) => Object.fromEntries([...m.entries()].map(([k, v]) => [k, v.slice(0, limit)]));
    return {
      ...meta(),
      id: refs[0].entry.id,
      name: refs[0].entry.name ?? refs[0].entry.id,
      anywhere: refs.length > 1 ? refs.map((r) => r.file) : undefined,
      out: trim(out),
      in: trim(inn),
    };
  }

  /**
   * How two entries are connected: the shortest chain of references between them, each step labelled
   * with the field that made it.
   *
   * This is the question `related` cannot answer, because `related` is one hop and every real chain
   * in this corpus is longer. It is also why the answer is a path rather than a score: `basil —
   * planet→ mars — zodiac→ aries` explains itself, where "these are related" does not.
   */
  function path({ from, to, direction = 'both', max_depth: maxDepth = 4, max_paths: maxPaths = 3 } = {}) {
    for (const [name, value] of [
      ['from', from],
      ['to', to],
    ]) {
      if (typeof value !== 'string' || !value.trim()) {
        return fail('bad_request', `\`path\` needs \`${name}\` — an entry id.`, 'Use `lookup` or `search` to find the id first.');
      }
    }

    const start = from.trim().toLowerCase();
    const end = to.trim().toLowerCase();
    const nearMiss = (value) => {
      const near = runSearch(docs, value, { limit: 3 }).results;
      return near.length
        ? `Did you mean: ${near.map((h) => h.doc.ref.entry.id).join(', ')}?`
        : 'Use `search` to find it first.';
    };
    if ((corpus.byId.get(start) ?? []).length === 0) {
      return fail('not_found', `No entry with the id \`${from}\`.`, nearMiss(from));
    }
    if ((corpus.byId.get(end) ?? []).length === 0) {
      return fail('not_found', `No entry with the id \`${to}\`.`, nearMiss(to));
    }

    const depth = Math.min(6, Math.max(1, Number(maxDepth) || 4));
    const want = direction === 'out' || direction === 'in' ? direction : 'both';
    const found = pathBetween(corpus, graph, start, end, {
      direction: want,
      maxDepth: depth,
      maxPaths: Math.min(10, Math.max(1, Number(maxPaths) || 3)),
    });

    const describe = (id) => {
      const ref = (corpus.byId.get(id) ?? [])[0];
      if (!ref) return { id, name: id, file: null, url: null };
      return { id, name: ref.entry.name ?? ref.entry.id, file: ref.file, url: href(id, Boolean(ref.nested)) };
    };

    const paths = found.paths.map((steps) => {
      const ids = [start, ...steps.map((s) => s.id)];
      return {
        length: steps.length,
        nodes: ids.map(describe),
        edges: steps.map((s, i) => ({ from: ids[i], field: s.field, direction: s.direction, to: ids[i + 1] })),
      };
    });

    return {
      ...meta(),
      from: describe(start),
      to: describe(end),
      direction: want,
      found: paths.length > 0,
      length: found.length,
      paths,
      explored: found.explored,
      depth_searched: depth,
      caveats: [
        'A path follows declared references only. 383 entries carry no reference in either direction, so two things can be related in meaning and still have no path — this reports the graph, not the concepts.',
      ],
      ...(paths.length === 0
        ? {
            hint: `No path within ${depth} hop(s). Raise \`max_depth\` (max 6)${
              want === 'both' ? '' : ', or use direction "both" to allow reverse edges'
            }.`,
          }
        : {}),
      ...(paths.length > 1
        ? {
            note: `These are the ${paths.length} shortest paths. A dense corpus usually has more, and every one of them is true.`,
          }
        : {}),
    };
  }

  /** Browse a catalogue, or the catalogue of catalogues. */
  function list({ file, section, limit = 50, offset = 0 } = {}) {
    const lim = clamp(limit, 50);
    const off = Math.max(0, Number(offset) || 0);

    if (!file && !section) {
      return {
        ...meta(),
        collections: corpus.collections.map((c) => ({
          file: c.file,
          key: c.key,
          title: c.title,
          section: c.section,
          glyph: c.glyph,
          entries: c.entries.filter((e) => !isSystemEntry(e)).length,
        })),
        hint: 'Pass `file` (e.g. `herbs.json` or `herbs`) to list its entries, or `section` to list its files.',
      };
    }

    const targets = corpus.collections.filter(
      (c) => (!file || c.file === file || c.key === file) && (!section || c.section === section),
    );
    if (targets.length === 0) {
      return fail('not_found', `No collection matching \`${file ?? section}\`.`, 'Call `list` with no arguments to see every collection.');
    }

    const entries = targets.flatMap((c) =>
      c.entries.filter((e) => !isSystemEntry(e)).map((e) => entrySummary({ entry: e, file: c.file, collection: c, nested: false })),
    );

    return {
      ...meta(),
      collections: targets.map((c) => ({ file: c.file, key: c.key, title: c.title, section: c.section })),
      total: entries.length,
      offset: off,
      count: Math.min(lim, Math.max(0, entries.length - off)),
      entries: entries.slice(off, off + lim),
      ...(off + lim < entries.length ? { next_offset: off + lim } : {}),
    };
  }

  /** What is true right now: planetary day and hour, moon, season, nearest sabbat. */
  function timing({ date, latitude, longitude, hemisphere } = {}) {
    let when = new Date();
    if (date) {
      when = new Date(date);
      if (Number.isNaN(when.getTime())) {
        return fail('bad_request', `\`${date}\` is not a date I can read.`, 'Use ISO 8601, e.g. 2026-10-31T20:00:00+11:00.');
      }
    }
    const lat = latitude === undefined || latitude === null ? undefined : Number(latitude);
    const lon = longitude === undefined || longitude === null ? undefined : Number(longitude);
    if ((lat !== undefined && !Number.isFinite(lat)) || (lon !== undefined && !Number.isFinite(lon))) {
      return fail('bad_request', 'latitude and longitude must be numbers.');
    }
    return { ...meta(), ...timingSnapshot(corpus, { date: when, latitude: lat, longitude: lon, hemisphere }) };
  }

  /**
   * Rank the corpus's workings against conditions. With no conditions given it uses the timing
   * snapshot for now, which makes "what should I do tonight" a single call.
   */
  function fits({ date, latitude, longitude, hemisphere, moon_sign: moonSign, season: seasonOverride, limit = 10 } = {}) {
    const snap = timing({ date, latitude, longitude, hemisphere });
    if (snap.error) return snap;

    // The corpus's `optimal_timing.days` holds weekday names ('saturday'), and the website scores
    // against those. This passed the *planetary ruler* ('saturn') until 2026-11-01, so the Day
    // factor — the heaviest at 25 points — could never match and every working was ranked without it.
    const when = new Date(snap.at);
    const workings = corpus.collectionByFile.get('core_workings.json')?.entries ?? [];
    const conditions = {
      dayOfWeek: dayOfWeek(when),
      moonPhase: snap.moon.id,
      moonPhaseDisplay: snap.moon.display,
      moonSign: moonSign ? String(moonSign) : undefined,
      planetaryHourPlanet: snap.planetary_hour?.planet,
      season: seasonOverride ? String(seasonOverride) : snap.season,
      timeOfDay: snap.time_of_day,
      sabbat: snap.sabbat,
    };

    const ranked = scoreWorkings(workings, conditions);
    return {
      ...meta(),
      at: snap.at,
      conditions: {
        weekday: conditions.dayOfWeek,
        planetary_day: snap.planetary_day,
        planetary_hour: conditions.planetaryHourPlanet,
        moon_phase: conditions.moonPhase,
        moon_sign: conditions.moonSign ?? null,
        season: conditions.season,
        time_of_day: conditions.timeOfDay,
        sabbat: snap.sabbat ? snap.sabbat.id : null,
      },
      basis: snap.basis,
      count: Math.min(clamp(limit, 10), ranked.length),
      workings: ranked.slice(0, clamp(limit, 10)),
      caveats: [
        ...snap.caveats,
        ...(conditions.moonSign ? [] : ['No moon sign supplied, so the sign factor was skipped rather than scored as a miss.']),
        'Only `core_workings.json` is ranked; rituals and talismans are in their own catalogues.',
      ],
    };
  }

  /**
   * When? The forward half of `timing`.
   *
   * `timing` answers "what is true now", which is the wrong shape for the question people actually
   * ask next: which day, which hour, how long until. So this looks forward over a horizon and
   * returns the next phase, the next sabbat, the next hour of a planet, and — given a working — the
   * windows the corpus's own election says are best.
   */
  function when({
    from,
    date,
    days = 30,
    latitude,
    longitude,
    hemisphere,
    planet,
    phase,
    working,
    limit = 5,
    daylight_only: daylightOnly = false,
  } = {}) {
    let start = new Date();
    const given = from ?? date;
    if (given) {
      start = new Date(given);
      if (Number.isNaN(start.getTime())) {
        return fail('bad_request', `\`${given}\` is not a date I can read.`, 'Use ISO 8601, e.g. 2026-10-31T20:00:00+11:00.');
      }
    }

    const lat = latitude === undefined || latitude === null ? undefined : Number(latitude);
    const lon = longitude === undefined || longitude === null ? undefined : Number(longitude);
    if ((lat !== undefined && !Number.isFinite(lat)) || (lon !== undefined && !Number.isFinite(lon))) {
      return fail('bad_request', 'latitude and longitude must be numbers.');
    }

    const horizon = Math.min(90, Math.max(1, Number(days) || 30));
    const end = new Date(start.getTime() + horizon * 86400000);
    const basis = planetaryHours(corpus, start, { latitude: lat, longitude: lon }).basis;

    // Phases default to the four cardinal ones: those are what people ask, and returning all eight
    // would bury the answer in crescents.
    const knownPhases = new Set(MOON_PHASES.map((p) => p.id));
    const wanted =
      phase === undefined
        ? ['full_moon', 'new_moon', 'first_quarter', 'last_quarter']
        : (Array.isArray(phase) ? phase : [phase]).map((p) => String(p).trim().toLowerCase());
    const unknownPhases = wanted.filter((p) => !knownPhases.has(p));
    if (unknownPhases.length > 0) {
      return fail(
        'bad_request',
        `Unknown phase \`${unknownPhases.join('`, `')}\`.`,
        `Phases: ${[...knownPhases].join(', ')}.`,
      );
    }
    const phases = [...new Set(wanted)]
      .map((id) => nextMoonPhase(start, id))
      .filter(Boolean)
      .sort((a, b) => a.date.localeCompare(b.date));

    // Whole days between local calendar dates: on the festival itself that is 0, not -1.
    const daysBetween = (a, b) =>
      Math.round((new Date(a).setHours(0, 0, 0, 0) - new Date(b).setHours(0, 0, 0, 0)) / 86400000);
    const sabbats = sabbatsInRange(corpus, start, end).map(({ when: at, ...rest }) => ({
      ...rest,
      days_away: daysBetween(at, start),
    }));

    const planetWanted = planet === undefined || planet === null || planet === '' ? null : String(planet).trim().toLowerCase();
    if (planetWanted && !CHALDEAN_ORDER.includes(planetWanted)) {
      return fail(
        'bad_request',
        `\`${planet}\` is not one of the seven planetary rulers.`,
        `Use one of: ${CHALDEAN_ORDER.join(', ')}.`,
      );
    }
    const hour = planetWanted
      ? nextPlanetaryHour(corpus, planetWanted, { from: start, latitude: lat, longitude: lon, daylightOnly: Boolean(daylightOnly) })
      : null;

    let workingBlock;
    if (working !== undefined && working !== null && working !== '') {
      const id = String(working).trim().toLowerCase();
      const found = (corpus.collectionByFile.get('core_workings.json')?.entries ?? []).find((e) => e.id === id);
      if (!found) {
        const near = runSearch(docs, working, { limit: 3 }).results;
        return fail(
          'not_found',
          `No working with the id \`${working}\`.`,
          near.length
            ? `Did you mean: ${near.map((h) => h.doc.ref.entry.id).join(', ')}?`
            : 'Only `core_workings.json` is scored; call `list?file=core_workings` to see all 49.',
        );
      }
      workingBlock = {
        id: found.id,
        name: found.name,
        windows: workingWindows(corpus, found, {
          from: start,
          days: horizon,
          latitude: lat,
          longitude: lon,
          hemisphere,
          limit: Math.min(20, Math.max(1, Number(limit) || 5)),
        }),
      };
    }

    return {
      ...meta(),
      at: start.toISOString(),
      horizon_days: horizon,
      basis,
      moon: { now: moonPhase(start), next: phases },
      sabbats,
      ...(planetWanted ? { hour } : {}),
      ...(workingBlock ? { working: workingBlock } : {}),
      ...(planetWanted && !hour
        ? { hint: 'No such hour within 7 days. Try without `daylight_only`.' }
        : {}),
      caveats: [
        basis === 'approximation'
          ? "No latitude/longitude supplied: hour boundaries use a flat 6am/6pm in *the server's* time zone, which is only close to the truth if you are near it. Pass latitude and longitude for windows that mean anything locally."
          : 'Sunrise and sunset computed for the supplied latitude/longitude.',
        'Phase dates come from the mean synodic month and are accurate to about a day. The instant given is the middle of the phase window — opposition for the full moon, conjunction for the new — not an almanac time.',
        ...(workingBlock
          ? [
              'Working windows skip the moon-sign factor (there is no ephemeris here), so percentages rank against each other within this response, not against the website\'s absolute scores.',
            ]
          : []),
      ],
    };
  }

  /** The raw corpus, for a consumer that would rather have the files than the API. */
  function collectionsMeta() {
    return {
      ...meta(),
      sections: corpus.catalog.sections,
      files: corpus.collections.map((c) => ({
        file: c.file,
        key: c.key,
        title: c.title,
        section: c.section,
        entries: c.entries.filter((e) => !isSystemEntry(e)).length,
      })),
    };
  }

  return {
    corpus,
    graph,
    docs,
    version,
    meta,
    info,
    lookup,
    search,
    find,
    entry,
    related,
    path,
    list,
    timing,
    when,
    fits,
    collections: collectionsMeta,
    provenanceOf,
  };
}
