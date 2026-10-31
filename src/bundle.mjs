// The bundle: the whole corpus in one file, plus the table that says how it joins.
//
// This is the artifact that makes the corpus usable without a checkout. It matters more than it
// first appears: the corpus repository is private on GitHub, so "clone both repos" is not an
// instruction a stranger can follow. The public ways in have to be the API and a file they can
// download, and the MCP server has to be able to run from that file.
//
// One shape, three producers, so they cannot drift:
//
//   scripts/build-bundle.mjs   writes it to dist/ for release
//   GET /api/grimoire/bundle   serves it live from the site's own mirror
//   mcp/server.mjs --bundle    reads it back in, with no corpus checkout at all
//
// The attribution and licence travel *inside* the file. An unattributed copy of a CC BY-SA work is a
// licence violation, and a file gets moved around in ways a README does not.

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { corpusVersion } from './version.mjs';

export const SCHEMA = 'grimoire-bundle/1';

const META_FILES = new Set(['catalog.json', 'joins.json']);

/**
 * Assemble the bundle from parsed corpus files.
 * @param {{files: Record<string, any>, catalog: object, joins: object}} input
 */
export function buildBundle({ files, catalog, joins }) {
  const data = {};
  for (const [name, value] of Object.entries(files)) {
    if (name.endsWith('.json') && !META_FILES.has(name)) data[name] = value;
  }
  const version = corpusVersion(files, joins);

  const entries = Object.values(data).reduce(
    (n, arr) => n + (Array.isArray(arr) ? arr.filter((e) => e && typeof e.id === 'string').length : 0),
    0,
  );

  return {
    $schema: SCHEMA,
    meta: {
      corpus: version.version,
      files: Object.keys(data).length,
      entries,
      licence: 'CC BY-SA 4.0',
      licence_url: 'https://creativecommons.org/licenses/by-sa/4.0/',
      attribution: 'The Grimoire corpus — https://ensoul.so/grimoire',
      built_by: 'grimoire-surface',
      note:
        'Provenance lives on each entry as `tradition` / `culture` / `source` / `note`. Where ' +
        'traditions disagree the entry says so; it does not pick a winner. Keep those fields if you ' +
        'redistribute, and read `joins` before treating any value as a reference.',
    },
    catalog,
    joins,
    data,
  };
}

/**
 * Read a bundle back. Accepts `.json` or `.json.gz` — the gzipped one is the size that actually
 * gets downloaded, so it must be the one that works.
 *
 * Throws with a useful message rather than returning a half-built corpus: a bundle missing its
 * `joins` would silently resolve no references at all, which looks like a corpus with no links
 * rather than a broken file.
 */
export function readBundle(path) {
  let raw = readFileSync(path);
  if (raw[0] === 0x1f && raw[1] === 0x8b) raw = gunzipSync(raw);

  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err.message}`);
  }

  for (const key of ['meta', 'catalog', 'joins', 'data']) {
    if (!parsed[key]) throw new Error(`${path} is not a grimoire bundle — no \`${key}\` section.`);
  }
  if (parsed.$schema && parsed.$schema !== SCHEMA) {
    throw new Error(`${path} declares schema ${parsed.$schema}; this build reads ${SCHEMA}.`);
  }
  return parsed;
}

/** A bundle, as the inputs `buildCorpus()` wants. */
export function bundleToCorpusInput(bundle) {
  return {
    files: { ...bundle.data, 'catalog.json': bundle.catalog, 'joins.json': bundle.joins },
    catalog: bundle.catalog,
    joins: bundle.joins,
  };
}
