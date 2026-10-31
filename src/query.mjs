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
//   what does X point at      entry      (forward references)
//   what points at X          related    (backlinks — the reverse index)
//   what's in this file       list
//   what is true right now    timing
//   what fits these conditions  fits
//
// Every response carries `corpus.version`, so an answer can always be attributed to a specific
// state of the data.

import { loadCorpus, buildCorpus as buildCorpusFrom, isSystemEntry } from './corpus.mjs';
import { buildGraph } from './graph.mjs';
import { buildSearchIndex, search as runSearch, lookup as runLookup } from './search.mjs';
import { entrySummary, entryFull, edgeOut, edgeIn, provenanceOf } from './format.mjs';
import { corpusVersion } from './version.mjs';
import { timingSnapshot, scoreWorkings } from './timing.mjs';

const MAX_LIMIT = 200;

function fail(code, message, hint) {
  return { error: { code, message, ...(hint ? { hint } : {}) } };
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

    return {
      ...meta(),
      ambiguous: refs.length > 1,
      ...(refs.length > 1
        ? {
            also_in: refs.slice(1).map((r) => ({ file: r.file, collection: r.collection.key })),
            note: 'This id names more than one entry. The full record below is the first; `related` covers all of them.',
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

    const workings = corpus.collectionByFile.get('core_workings.json')?.entries ?? [];
    const conditions = {
      dayOfWeek: String(snap.planetary_day),
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
        planetary_day: conditions.dayOfWeek,
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
    entry,
    related,
    list,
    timing,
    fits,
    collections: collectionsMeta,
    provenanceOf,
  };
}
