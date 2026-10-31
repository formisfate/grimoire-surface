// Generate the website's `grimoire-joins.ts` from the corpus's `joins.json`.
//
// The join table used to live in the website as TypeScript, which meant the corpus's own rules were
// stored in a *consumer* and every new consumer had to copy them. It now lives with the data
// (`grimoire/joins.json`), and this script derives the site's copy. Run it after changing the
// corpus table:
//
//   node scripts/gen-joins.mjs            # rewrite the site's file
//   node scripts/gen-joins.mjs --check    # fail if the site's file is stale
//
// `--check` is what makes this maintenance rather than a one-off move: a stale join table is
// invisible — the site keeps working and quietly disagrees with the MCP server about what a
// reference is. The check makes that a build failure instead.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const check = argv.includes('--check');
const argOf = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};

const corpus = resolve(argOf('--corpus') ?? process.env.GRIMOIRE_DIR ?? resolve(ROOT, '..', 'grimoire'));
const target = resolve(
  argOf('--out') ?? resolve(ROOT, '..', 'ensoul-public', 'ensoul-web', 'src', 'lib', 'grimoire-joins.ts'),
);

const spec = JSON.parse(readFileSync(resolve(corpus, 'joins.json'), 'utf8'));

const oneLine = (obj) => JSON.stringify(obj);
const setOf = (arr) => `new Set([${arr.map((s) => JSON.stringify(s)).join(', ')}])`;

const out = `// The grimoire corpus's join-field table, as the site needs it.
//
// GENERATED — do not edit. The source of truth is \`grimoire/joins.json\` in the corpus repo; this
// file is derived from it by \`grimoire-surface/scripts/gen-joins.mjs\`. Editing here is silently
// undone the next time that runs, and until then the site and the MCP server disagree about what
// counts as a reference.
//
//   node grimoire-surface/scripts/gen-joins.mjs           # regenerate
//   node grimoire-surface/scripts/gen-joins.mjs --check   # fail if this file is stale
//
// The table mirrors the corpus's own (\`grimoire/AGENTS.md\`, "The join fields, exhaustively"), which
// is what decides whether a value inside an entry is a reference to another entry or just a word.
//
//   GLOBAL_JOINS    field name -> [target collection, files the value may resolve against]
//   SCOPED_JOINS    \`file|field\` -> the same, for fields whose meaning is file-specific
//                   (a planet's \`exaltation\` is a sign; a sign's \`exaltation\` is a planet)
//   CONTAINERS      keys whose object groups more values (\`{"primary": [...], "secondary": [...]}\`)
//   NOT_JOINS       (file, field, path-substring) triples that hold a labelled vocabulary, not refs
//   META_VALUES     values that are legal in a reference field and mean "everything" or "nothing"

export type JoinSpec = [target: string, files: string[]];

export const GLOBAL_JOINS: Record<string, JoinSpec> = ${oneLine(spec.global)};

export const SCOPED_JOINS: Record<string, JoinSpec> = ${oneLine(spec.scoped)};

export const CONTAINERS: ReadonlySet<string> = ${setOf(spec.containers)};

export interface NotJoin { file: string; field: string; sub: string | null; why: string }

export const NOT_JOINS: NotJoin[] = ${oneLine(spec.not_joins)};

export const META_VALUES: ReadonlySet<string> = ${setOf(spec.meta_values)};

export function isMeta(v: unknown): boolean {
  return typeof v === 'string' && (META_VALUES.has(v) || v.startsWith('all_'));
}

export function isNotJoin(file: string, field: string, path: string): boolean {
  // The corpus records these as slash-prefixed paths (\`/best_timing\`); callers here walk with dots.
  const p = path.replace(/\\./g, '/');
  return NOT_JOINS.some(
    (n) => n.file === file && n.field === field && (n.sub === null || p.includes(n.sub.replace(/^\\//, ''))),
  );
}

export function joinSpec(file: string, field: string, path = ''): JoinSpec | undefined {
  if (isNotJoin(file, field, path)) return undefined;
  return SCOPED_JOINS[\`\${file}|\${field}\`] ?? GLOBAL_JOINS[field];
}
`;

if (check) {
  const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
  if (current !== out) {
    console.error(`grimoire-joins.ts is stale — the corpus's joins.json has moved on.\n  corpus: ${corpus}\n  target: ${target}\n\nRegenerate:\n  node ${argv[1] === '--check' ? 'scripts/gen-joins.mjs' : 'scripts/gen-joins.mjs'}`);
    process.exit(1);
  }
  console.log('grimoire-joins.ts is in step with the corpus.');
} else {
  writeFileSync(target, out);
  console.log(`wrote ${target}`);
  console.log(`  global ${Object.keys(spec.global).length} · scoped ${Object.keys(spec.scoped).length} · not_joins ${spec.not_joins.length} · meta ${spec.meta_values.length} · containers ${spec.containers.length}`);
}
