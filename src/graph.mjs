// The corpus as a graph.
//
// This is the layer the corpus has always had in principle and only recently had in code: entries
// reference each other by id — a stone says which planet rules it, a deity says which herbs are its
// own, a working says which hour supports it — and those references were plain text until the
// graph was built. This module rebuilds that graph from the corpus alone, so that anything which
// consumes it (the MCP server, the HTTP API, the bundle) sees the same edges the website does.
//
// Three questions, which is all a caller ever wants:
//
//   entriesById(id)      what does this id name? (an id can exist in two catalogues — `sage` is an
//                        archetype, a herb and a resin — so this returns every entry carrying it)
//   forwardRefs(entry)   what does this entry point at, and through which field?
//   backlinks(id)        what points back at it?
//
// What counts as a reference is NOT decided here. It is `joins.json`, via `src/joins.mjs`. That
// separation is the whole point: without it every use of the word "protection" would look like a
// link to a working called `protection`, and every moon phase's `direction` would look like a
// compass bearing.

import { isSystemEntry } from './corpus.mjs';

// Constructor keys — keys whose object only *groups* more values (`{"primary": [...]}`) rather than
// naming an entry itself. They mean "keep descending", not "this is a target".
//
// The set is declared by the corpus (`joins.json` → `containers`), not hard-coded here. It used to be
// hard-coded in two places — this walker and the website's — as a 13-key subset of the 19 the corpus
// declared, which is the exact kind of duplicated rule this project keeps getting bitten by. The two
// sets were measured against the corpus and produce identical graphs, so adopting the declared set
// changed no answer while leaving only one copy to maintain.

/**
 * Walk an entry and collect raw references. Mirrors the corpus checker's own walker: the field name
 * decides whether a string is a reference, GROUPS says when an object is only a container, and
 * meta values are skipped because they mean "everything" rather than naming anything.
 */
function walkForRefs(node, file, joins, field, path, out) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => walkForRefs(v, file, joins, field, `${path}.${i}`, out));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      const childPath = path ? `${path}.${k}` : k;
      const spec = joins.joinSpec(file, k, path);
      if (spec && joins.containers.has(k)) {
        walkForRefs(v, file, joins, k, childPath, out);
      } else if (spec) {
        walkRefValue(v, file, joins, k, childPath, out);
      } else {
        walkForRefs(v, file, joins, k, childPath, out);
      }
    }
    return;
  }
  if (typeof node === 'string' && field) {
    const spec = joins.joinSpec(file, field, path);
    if (spec && !joins.isMeta(node)) out.push({ path, field, id: node });
  }
}

function walkRefValue(node, file, joins, field, path, out) {
  const spec = joins.joinSpec(file, field, path);
  if (!spec) {
    walkForRefs(node, file, joins, field, path, out);
    return;
  }
  if (typeof node === 'string') {
    if (!joins.isMeta(node)) out.push({ path, field, id: node });
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => {
      if (typeof v === 'string') {
        if (!joins.isMeta(v)) out.push({ path: `${path}.${i}`, field, id: v });
      } else {
        walkForRefs(v, file, joins, field, `${path}.${i}`, out);
      }
    });
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (joins.containers.has(k)) walkRefValue(v, file, joins, field, `${path}.${k}`, out);
      else walkForRefs(v, file, joins, k, `${path}.${k}`, out);
    }
  }
}

export function buildGraph(corpus) {
  const byId = corpus.byId;
  const forward = new Map();
  const back = new Map();
  let refCount = 0;
  let dangling = 0;

  for (const c of corpus.collections) {
    for (const entry of c.entries) {
      if (isSystemEntry(entry)) continue;

      const found = [];
      walkForRefs(entry, c.file, corpus.joins, undefined, '', found);

      const refs = [];
      for (const f of found) {
        const targets = byId.get(f.id) ?? [];
        if (targets.length === 0) dangling += 1;
        refs.push({ path: f.path, field: f.field, id: f.id, targets });
        refCount += 1;
        const bl = back.get(f.id) ?? [];
        bl.push({ file: c.file, entry, path: f.path, field: f.field });
        back.set(f.id, bl);
      }
      forward.set(entry, refs);
    }
  }

  return {
    forward,
    back,
    refCount,
    /**
     * References naming an id no file defines. The corpus measures zero of these; a non-zero count
     * is the single most useful signal that an edit broke a join, so it is surfaced rather than
     * swallowed.
     */
    dangling,
    entriesById: (id) => byId.get(id) ?? [],
    entryExists: (id) => byId.has(id),
    forwardRefs: (entry) => forward.get(entry) ?? [],
    backlinks: (id) => back.get(id) ?? [],
  };
}
