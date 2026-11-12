// Search across the corpus.
//
// The corpus is small enough to keep in memory and small enough that a full rebuild of this index
// takes a few tens of milliseconds, so there is no inverted-index package, no stemming, and no
// ranking library. What matters here is different: the corpus deliberately reuses words. `sage` is
// an archetype, a herb and a resin; `spirit` is an element that was renamed `aether`; a great many
// entries mention "protection" without being about it. A search that treats every occurrence alike
// is useless on this data.
//
// So each field is weighted by how *identifying* it is, and the weights are the whole design:
//
//   id / name            10   what the thing is called
//   alternate_names       7   the name another tradition uses for it
//   keywords              5   the corpus's own subject tags
//   summary               2   the entry's one-liner
//   everything else       1   the body text
//
// Matching is on normalised tokens: lowercased, diacritics stripped, underscores and hyphens
// treated as spaces. A query must match every token somewhere (AND) for precision; if that finds
// nothing the search retries any-token (OR) so a two-word query cannot come back empty-handed.

const FIELD_WEIGHTS = {
  id: 10,
  name: 10,
  title: 8,
  alternate_names: 7,
  alternate_name: 7,
  keywords: 5,
  aliases: 5,
  summary: 2,
  description: 2,
  meaning: 2,
  mythology_summary: 2,
  function: 2,
};

export function normalise(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[_\-\/]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s) {
  const n = normalise(s);
  return n ? n.split(' ') : [];
}

/** Flatten every string in an entry into weighted text, once, at index time. */
function collectText(entry, out, weightHint = 1, key = '', depth = 0) {
  if (depth > 6 || entry === null || entry === undefined) return;
  if (typeof entry === 'string') {
    const w = key ? (FIELD_WEIGHTS[key] ?? weightHint) : weightHint;
    out.push({ text: entry, weight: w, field: key });
    return;
  }
  if (Array.isArray(entry)) {
    for (const v of entry) collectText(v, out, weightHint, key, depth + 1);
    return;
  }
  if (typeof entry === 'object') {
    for (const [k, v] of Object.entries(entry)) {
      // `note` and provenance are searched at body weight: they are how you find "the entry that
      // mentions the Enochian ordering dispute", but they are not what identifies an entry.
      collectText(v, out, FIELD_WEIGHTS[k] ?? weightHint, k, depth + 1);
    }
  }
}

export function buildSearchIndex(corpus) {
  const docs = [];
  for (const c of corpus.collections) {
    for (const entry of c.entries) {
      const text = [];
      collectText(entry, text);
      const tokensByField = text.map((t) => ({ field: t.field, weight: t.weight, tokens: tokens(t.text) }));
      docs.push({
        ref: { entry, file: c.file, collection: c, nested: false },
        idTokens: tokens(entry.id),
        nameTokens: tokens(entry.name ?? entry.title ?? ''),
        tokensByField,
      });
    }
  }
  // Nested ids (the tarot suits) are searchable too, but they have no page of their own.
  for (const [, refs] of corpus.byId) {
    for (const ref of refs) {
      if (!ref.nested) continue;
      const text = [];
      collectText(ref.entry, text);
      docs.push({
        ref,
        idTokens: tokens(ref.entry.id),
        nameTokens: tokens(ref.entry.name ?? ref.entry.title ?? ''),
        tokensByField: text.map((t) => ({ field: t.field, weight: t.weight, tokens: tokens(t.text) })),
      });
    }
  }
  return docs;
}

function scoreDoc(doc, queryTokens) {
  let score = 0;
  const matched = new Set();

  for (const token of queryTokens) {
    let best = 0;
    if (doc.idTokens.includes(token) || doc.nameTokens.includes(token)) {
      best = 10;
    } else {
      for (const group of doc.tokensByField) {
        if (!group.tokens.includes(token)) continue;
        if (group.weight > best) best = group.weight;
      }
    }
    if (best > 0) {
      score += best;
      matched.add(token);
    }
  }

  // An exact id or name hit should always outrank a body mention.
  const joined = normalise(queryTokens.join(' '));
  if (doc.idTokens.join(' ') === joined || doc.nameTokens.join(' ') === joined) score += 40;

  return { score, matched: [...matched] };
}

/**
 * Search the corpus.
 * `file` narrows to one catalogue; `section` to one archive section; both accept a key.
 */
export function search(docs, query, { file, section, limit = 20 } = {}) {
  const queryTokens = tokens(query);
  if (queryTokens.length === 0) return [];

  let pool = docs;
  if (file) pool = pool.filter((d) => d.ref.file === file || d.ref.collection.key === file);
  if (section) pool = pool.filter((d) => d.ref.collection.section === section);

  const rank = (tokensToUse, requireAll) => {
    const hits = [];
    for (const doc of pool) {
      const { score, matched } = scoreDoc(doc, tokensToUse);
      if (score <= 0) continue;
      if (requireAll && matched.length < tokensToUse.length) continue;
      hits.push({ doc, score, matched });
    }
    return hits.sort((a, b) => b.score - a.score || String(a.doc.ref.entry.id).localeCompare(String(b.doc.ref.entry.id)));
  };

  let hits = rank(queryTokens, true);
  let mode = 'all-terms';
  if (hits.length === 0) {
    hits = rank(queryTokens, false);
    mode = 'any-term';
  }

  const sectionFacets = {};
  for (const hit of hits) {
    const section = hit.doc.ref.collection.section;
    sectionFacets[section] = (sectionFacets[section] ?? 0) + 1;
  }

  return {
    mode,
    total: hits.length,
    facets: { section: sectionFacets },
    results: hits.slice(0, limit),
  };
}

/**
 * Direct resolution: an id, then a name, then an alternate name.
 *
 * This is the "I know what I am asking for" path, and it should not depend on ranking. `sage`
 * legitimately returns three entries — an archetype, a herb and a resin — and the caller is told
 * exactly that rather than being handed the top-scoring one and left unaware of the others.
 */
export function lookup(corpus, docs, query, { file, limit = 10 } = {}) {
  const q = normalise(query);
  if (!q) return { mode: 'empty', results: [] };

  const inScope = (ref) => !file || ref.file === file || ref.collection.key === file;

  const byId = (corpus.byId.get(q) ?? []).filter(inScope);
  if (byId.length) return { mode: 'id', results: byId.map((r) => ({ ref: r, how: 'id' })).slice(0, limit) };

  const byName = [];
  const byAlternate = [];
  for (const doc of docs) {
    if (!inScope(doc.ref)) continue;
    if (doc.nameTokens.join(' ') === q) byName.push(doc.ref);
    else if (
      (doc.ref.entry.alternate_names ?? []).some((n) => normalise(n) === q) ||
      (doc.ref.entry.alternate_name ?? '').toLowerCase() === q
    ) {
      byAlternate.push(doc.ref);
    }
  }

  if (byName.length) {
    return { mode: 'name', results: byName.map((r) => ({ ref: r, how: 'name' })).slice(0, limit) };
  }
  if (byAlternate.length) {
    return { mode: 'alternate-name', results: byAlternate.map((r) => ({ ref: r, how: 'alternate-name' })).slice(0, limit) };
  }

  const found = search(docs, query, { file, limit });
  return { mode: `fuzzy:${found.mode}`, results: found.results.map((h) => ({ ref: h.doc.ref, how: 'search', score: h.score })) };
}
