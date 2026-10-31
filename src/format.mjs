// How an entry is presented to the outside world.
//
// One rule governs this file: **provenance is never dropped.** The corpus's whole editorial
// discipline is that a contested claim goes out with its `tradition` and its `note` attached — it is
// what separates this from a table of correspondences scraped off a blog. A convenience layer that
// quietly returned `{id, name, planet}` would launder "Agrippa says" into "is", and that is the
// single most likely way for this project to lose the thing that makes it worth citing.
//
// So: every compact form carries `provenance`, even when every field in it is null. A student can
// tell the difference between "the corpus says this" and "one source says this, and the corpus
// records the disagreement".
//
// The full form returns the entry *unmodified* (plus `_meta`). Nothing is filtered, renamed or
// flattened, because a consumer that wants the raw object should get exactly what is in the repo.

const SITE = 'https://ensoul.so';

/** The canonical web page for an id. Nested ids (the tarot suits) have none. */
export function href(id, nested = false) {
  return nested ? null : `${SITE}/grimoire/e/${encodeURIComponent(id)}`;
}

/**
 * The provenance fields, as the corpus defines them. `note` is included because in this corpus it
 * is where a caveat lives — that a correspondence is a modern overlay, that a figure is literary
 * rather than a cult deity, that a value was retargeted.
 */
export function provenanceOf(entry) {
  const out = {};
  if (entry?.tradition !== undefined) out.tradition = entry.tradition;
  if (entry?.culture !== undefined) out.culture = entry.culture;
  if (entry?.origin !== undefined) out.origin = entry.origin;
  if (entry?.source !== undefined) out.source = entry.source;
  if (entry?.sources !== undefined) out.sources = entry.sources;
  if (entry?.note !== undefined) out.note = entry.note;
  return out;
}

/** True when the entry says nothing about where it comes from. A real corpus signal, not noise. */
export function isUntraced(entry) {
  return !entry?.tradition && !entry?.culture && !entry?.origin && !entry?.source && !entry?.sources;
}

/** The one-line human summary of an entry, whichever field the file happens to use. */
export function summaryOf(entry) {
  for (const k of ['summary', 'description', 'meaning', 'mythology_summary', 'overview', 'function']) {
    const v = entry?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * The compact form: enough to decide whether to ask for more.
 * `provenance` is always present (possibly empty), never omitted.
 */
export function entrySummary(ref) {
  const { entry, file, collection, nested } = ref;
  return {
    id: entry.id,
    name: entry.name ?? entry.title ?? entry.id,
    file,
    collection: collection.key,
    collection_title: collection.title,
    section: collection.section,
    type: entry.type ?? null,
    summary: summaryOf(entry),
    provenance: provenanceOf(entry),
    untraced: isUntraced(entry),
    url: href(entry.id, nested),
  };
}

/** The full form: the entry exactly as the corpus holds it, plus addressing. */
export function entryFull(ref, { forward = [], back = [] } = {}) {
  const { entry, file, collection, nested } = ref;
  return {
    ...entry,
    _meta: {
      file,
      collection: collection.key,
      collection_title: collection.title,
      section: collection.section,
      nested: Boolean(nested),
      url: href(entry.id, nested),
      provenance: provenanceOf(entry),
      untraced: isUntraced(entry),
      references_out: forward.length,
      references_in: back.length,
    },
  };
}

/** A reference edge, as it appears in `related` and on an entry's links. */
export function edgeOut(corpus, ref) {
  return {
    field: ref.field,
    path: ref.path,
    id: ref.id,
    resolves: ref.targets.length > 0,
    targets: ref.targets.map((t) => entrySummary(t)),
  };
}

export function edgeIn(corpus, link) {
  const collection = corpus.collectionByFile.get(link.file);
  const ref = { entry: link.entry, file: link.file, collection, nested: false };
  return {
    field: link.field,
    path: link.path,
    entry: entrySummary(ref),
  };
}
