// The corpus as a graph.
//
// This is the layer the corpus has always had in principle and only recently had in code: entries
// reference each other by id — a stone says which planet rules it, a deity says which herbs are its
// own, a working says which hour supports it — and those references were plain text until the
// graph was built. This module rebuilds that graph from the corpus alone, so that anything which
// consumes it (the MCP server, the HTTP API, the bundle) sees the same edges the website does.
//
// Four questions, which is all a caller ever wants:
//
//   entriesById(id)      what does this id name? (an id can exist in two catalogues — `sage` is an
//                        archetype, a herb and a resin — so this returns every entry carrying it)
//   forwardRefs(entry)   what does this entry point at, and through which field?
//   backlinks(id)        what points back at it?
//   pathBetween(a, b)    how are these two connected, and through which fields?
//
// The fourth was added on 2026-11-01, after the surface had a one-hop `related` and a README whose
// headline example needed two hops. Every path in this corpus is labelled by the field that makes
// it — `basil —planet→ mars —planets(in)→ protection` — so a path is an explanation, not just a
// list of ids. Note the second edge is a *backlink*: a real chain turns around.
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

/**
 * One step out from an id, as directed edges.
 *
 * `out` follows the entry's own references (what it points at); `in` follows the reverse index (what
 * points at it). `both` follows both, and it is the default because the corpus's own headline
 * question needs it: basil reaches Mars forward, but the workings that call for Mars are reached
 * *backwards* from Mars — a strict forward walk covers half of that chain and then stops.
 *
 * Every edge keeps the field that made it, deduplicated, so `basil —planet→ mars` and
 * `basil —pairs_with→ sage` are different edges rather than the same neighbour twice.
 */
export function neighbours(corpus, graph, id, { direction = 'both' } = {}) {
  const seen = new Set();
  const out = [];
  const push = (targetId, field, dir) => {
    const key = `${targetId}\u0000${field}\u0000${dir}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id: targetId, field, direction: dir });
  };

  if (direction !== 'in') {
    for (const ref of corpus.byId.get(id) ?? []) {
      for (const f of graph.forwardRefs(ref.entry)) {
        for (const t of f.targets) push(t.entry.id, f.field, 'out');
      }
    }
  }
  if (direction !== 'out') {
    for (const l of graph.backlinks(id)) push(l.entry.id, l.field, 'in');
  }
  return out;
}

/**
 * Shortest paths between two ids, as edge lists.
 *
 * Breadth-first, so the first answer is the shortest one and `length` is trustworthy. Then the
 * shortest-path DAG is walked to recover up to `maxPaths` of them, which matters because "how are
 * these connected" almost never has one honest answer: basil reaches the working called Protection
 * through Mars, through fire, through a herb it pairs with, and through two zodiac signs — five
 * shortest paths, every one of them true. Returning only the first would tell a smaller truth than
 * the corpus holds.
 *
 * Bounded on purpose. The corpus is dense — every entry reaches hundreds of others at two hops — so
 * an unbounded search would answer "yes" to almost every pair and tell you nothing. `maxDepth` makes
 * the answer honest about how far it looked.
 */
export function pathBetween(corpus, graph, from, to, { direction = 'both', maxDepth = 4, maxPaths = 3 } = {}) {
  const dist = new Map([[from, 0]]);
  const queue = [from];
  let targetDepth = null;

  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head];
    const d = dist.get(id);
    // Only nodes strictly nearer than the target can lie on a shortest path to it, so once the
    // target's depth is known there is nothing deeper worth expanding.
    if (targetDepth !== null && d >= targetDepth) continue;
    if (d >= maxDepth) continue;

    for (const n of neighbours(corpus, graph, id, { direction })) {
      if (dist.has(n.id)) continue;
      dist.set(n.id, d + 1);
      if (n.id === to) targetDepth = d + 1;
      queue.push(n.id);
    }
  }

  const paths = [];
  if (dist.has(to)) {
    // Recover paths that follow the BFS distance exactly one step at a time: any such walk is a
    // shortest path, and revisiting is impossible because the distance strictly increases.
    const walk = (id, steps) => {
      if (paths.length >= maxPaths) return;
      if (id === to) {
        paths.push(steps);
        return;
      }
      for (const n of neighbours(corpus, graph, id, { direction })) {
        if (dist.get(n.id) !== dist.get(id) + 1) continue;
        walk(n.id, [...steps, n]);
        if (paths.length >= maxPaths) return;
      }
    };
    walk(from, []);
  }

  return { paths, length: paths[0]?.length ?? null, explored: dist.size, direction };
}
