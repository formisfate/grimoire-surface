// Load the corpus into the shapes the rest of the surface needs.
//
// Two ways in, one code path out:
//
//   loadCorpus(dir)         read the 81 files off disk — what the MCP server does
//   buildCorpus({files})    take the files already parsed — what the website's HTTP API does,
//                           because the site already bundles the corpus as its own mirror and has
//                           no corpus checkout at runtime
//
// They converge immediately, so the graph, the search index and every answer built on them are
// identical whichever entry point was used. That is the point: the agent asking over MCP and the
// browser asking the API must never get different corpora.
//
// Where the corpus lives on disk is deliberately flexible, because the same code has to run from a
// git checkout on a laptop and from a deploy on a server:
//
//   1. an explicit path (the CLI flags use this)
//   2. $GRIMOIRE_DIR
//   3. ../grimoire  — the workspace layout, where the two repos sit side by side
//   4. ./grimoire
//
// If none exist the error lists what it tried, because the most likely failure for a new user is
// "cloned one repo, not two".

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJoins } from './joins.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Files that are corpus metadata rather than catalogues of entries. */
const META_FILES = new Set(['joins.json', 'catalog.json']);

/**
 * Addressable things that live *inside* a file's system entry rather than at the top level.
 *
 * The corpus names exactly one such case. The tarot's four suits are the members of
 * `tarot_system.suits`, and `grimoire/AGENTS.md` says so explicitly: "the four suit **ids are the
 * bare names** — `wands`, `cups`, `swords`, `pentacles` — which is what the 80 suit-level values
 * across the corpus already say; they are the `id`s of the suit objects inside
 * `tarot_system.suits`". Without this, 160 references to the suits resolve to nothing and look
 * like broken data.
 *
 * They carry no `/grimoire/e/<id>` page, so they are indexed with `nested: true` and callers must
 * render them as text rather than a link.
 */
const NESTED_IDS = [{ file: 'tarot_complete.json', path: ['suits'] }];

function nestedEntries(file, entries) {
  const rule = NESTED_IDS.find((r) => r.file === file);
  if (!rule) return [];
  const out = [];
  for (const e of entries) {
    let node = e;
    for (const step of rule.path) node = node?.[step];
    if (!node || typeof node !== 'object') continue;
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object' && typeof v.id === 'string') out.push(v);
    }
  }
  return out;
}

export function resolveCorpusDir(explicit) {
  const candidates = [];
  if (explicit) candidates.push(resolve(explicit));
  if (process.env.GRIMOIRE_DIR) candidates.push(resolve(process.env.GRIMOIRE_DIR));
  candidates.push(resolve(HERE, '..', '..', 'grimoire'));
  candidates.push(resolve(HERE, '..', 'grimoire'));
  candidates.push(resolve(process.cwd(), 'grimoire'));

  for (const c of candidates) {
    if (existsSync(join(c, 'catalog.json')) && existsSync(join(c, 'joins.json'))) return c;
  }

  const tried = candidates.map((c) => `  - ${c}`).join('\n');
  throw new Error(
    `Could not find the grimoire corpus.\n\nTried:\n${tried}\n\n` +
      `Point at it explicitly:\n  GRIMOIRE_DIR=/path/to/grimoire node mcp/server.mjs\n` +
      `The corpus is the separate \`grimoire\` repo; this repo only queries it.`,
  );
}

/**
 * An entry is not a thing a reader clicks; it is the file's own front matter describing the file.
 * It carries an id, so it would otherwise collide with real entries in the id index.
 */
export function isSystemEntry(entry) {
  const type = String(entry?.type ?? '');
  if (type === 'system_definition' || type === 'overview' || type === 'reference') return true;
  const id = String(entry?.id ?? '');
  return id.endsWith('_system') || id.endsWith('_reference') || id.endsWith('_overview');
}

/**
 * Build the loaded corpus from already-parsed files.
 *
 * @param {object} input
 * @param {Record<string, any>} input.files  file name -> parsed JSON, e.g. { 'herbs.json': [...] }
 * @param {object} input.catalog             the parsed catalog.json
 * @param {object} input.joins               the parsed joins.json
 * @param {string} [input.dir]               where it came from, for error messages
 */
export function buildCorpus({ files, catalog, joins, dir = null }) {
  const joinsApi = createJoins(joins);
  const colls = [];

  const onDisk = Object.keys(files)
    .filter((f) => f.endsWith('.json') && !META_FILES.has(f))
    .sort();
  const described = new Map((catalog.files ?? []).map((f) => [f.file, f]));

  const unlisted = [];
  for (const file of onDisk) {
    const meta = described.get(file);
    if (!meta) unlisted.push(file);
    const raw = files[file];
    const entries = (Array.isArray(raw) ? raw : []).filter(
      (e) => e && typeof e === 'object' && typeof e.id === 'string',
    );
    colls.push({
      file,
      key: meta?.key ?? file.replace(/\.json$/, ''),
      title: meta?.title ?? file.replace(/\.json$/, '').replace(/_/g, ' '),
      section: meta?.section ?? 'unfiled',
      sectionTitle: catalog.sections?.find((s) => s.key === (meta?.section ?? ''))?.title ?? 'Unfiled',
      glyph: meta?.glyph ?? '',
      browseHref: meta?.browse_href ?? null,
      entries,
      entryById: new Map(entries.map((e) => [e.id, e])),
    });
  }

  // One id can live in more than one catalogue and mean different things: `sage` is an archetype,
  // a herb and a resin. Keep every one of them; callers decide what to do with the ambiguity.
  const byId = new Map();
  const register = (ref) => {
    const bucket = byId.get(ref.entry.id) ?? [];
    bucket.push(ref);
    byId.set(ref.entry.id, bucket);
  };

  for (const c of colls) {
    for (const e of c.entries) {
      if (isSystemEntry(e)) continue;
      register({ file: c.file, collection: c, entry: e });
    }
    for (const e of nestedEntries(c.file, c.entries)) {
      register({ file: c.file, collection: c, entry: e, nested: true });
    }
  }

  return {
    dir,
    catalog,
    joins: joinsApi,
    joinsSpec: joins,
    collections: colls,
    collectionByFile: new Map(colls.map((c) => [c.file, c])),
    byId,
    unlisted,
    files,
    stats: {
      files: colls.length,
      entries: colls.reduce((n, c) => n + c.entries.filter((e) => !isSystemEntry(e)).length, 0),
      systemEntries: colls.reduce((n, c) => n + c.entries.filter(isSystemEntry).length, 0),
      ids: byId.size,
    },
  };
}

/** Read the corpus off disk and build it. */
export function loadCorpus(explicitDir) {
  const dir = resolveCorpusDir(explicitDir);
  const files = {};
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    files[file] = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  }
  return buildCorpus({
    files,
    catalog: files['catalog.json'],
    joins: files['joins.json'],
    dir,
  });
}
