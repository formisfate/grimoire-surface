// A deterministic fingerprint of the corpus, so a response can say exactly which corpus it came
// from and a cache can tell when it changed.
//
// It hashes a *canonical serialisation of the parsed data*, not the raw bytes and not mtimes:
//
// - mtimes differ on every clone (git does not preserve them), so a timestamp version is meaningless
//   across machines;
// - raw bytes would make the MCP server (reading files) and the website (importing its bundled
//   mirror) disagree about the version of the same corpus, because the two have different file
//   paths but identical content. Hashing the parsed shape gives both the same string.
//
// `joins.json` is included deliberately. A change to the reference table changes every answer in
// the whole surface, so it has to move the version even though no entry changed.

import { createHash } from 'node:crypto';

const META_FILES = new Set(['catalog.json', 'joins.json']);

/**
 * @param {Record<string, any>} files  parsed corpus files
 * @param {object} joins               parsed joins.json
 */
export function corpusVersion(files, joins) {
  const names = Object.keys(files)
    .filter((f) => f.endsWith('.json'))
    .sort();

  const hash = createHash('sha256');
  hash.update(JSON.stringify(joins));
  hash.update('\0');
  for (const name of names) {
    if (META_FILES.has(name)) continue;
    hash.update(name);
    hash.update('\0');
    hash.update(JSON.stringify(files[name]));
    hash.update('\0');
  }

  return {
    version: hash.digest('hex').slice(0, 12),
    files: names.filter((f) => !META_FILES.has(f)).length,
    licence: 'CC-BY-SA-4.0',
    attribution: 'The Grimoire corpus — https://ensoul.so/grimoire',
  };
}
