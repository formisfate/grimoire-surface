// Copy the query core into the website, so the site's HTTP API runs the *same* implementation as
// the MCP server.
//
// Why copy rather than import across repos: the website builds on the droplet from
// `ensoul-public/` alone, and a build-time import of a sibling repo would make the website
// undeployable whenever that repo is not checked out, in a way that fails at build rather than at
// runtime. Vendoring keeps the deploy self-contained. This is the same arrangement the corpus
// itself uses — `ensoul-web/src/data/grimoire/` is a byte-exact mirror of `grimoire/` — and the same
// guard applies: a `--check` that fails when the copy is stale.
//
// What is NOT copied is any data. The vendored code reads the site's own bundled mirror, so there
// is still exactly one copy of the corpus in the website.
//
//   node scripts/vendor-site.mjs            # rewrite the vendored copy
//   node scripts/vendor-site.mjs --check    # fail if it is stale

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const check = argv.includes('--check');
const argOf = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};

const srcDir = resolve(ROOT, 'src');
const outDir = resolve(
  argOf('--out') ?? resolve(ROOT, '..', 'ensoul-public', 'ensoul-web', 'src', 'vendor', 'grimoire-surface'),
);

const HEADER =
  '// VENDORED from grimoire-surface/src — do not edit here.\n' +
  '// Regenerate with: node grimoire-surface/scripts/vendor-site.mjs\n' +
  '// Check for drift:  node grimoire-surface/scripts/vendor-site.mjs --check\n\n';

const README = `# Vendored: grimoire-surface

This directory is a copy of \`grimoire-surface/src/\`, committed so the website builds and deploys on
its own. It is **generated** — editing anything here is silently undone the next time the vendoring
script runs, and until then the website and the MCP server disagree about what the corpus says.

The query surface (graph traversal, search, timing, response shaping) lives in
\`grimoire-surface/\` because the MCP server must run with no website and no build step. The website
runs the same code against its own bundled corpus mirror, so that a question asked over the API and
the same question asked over MCP cannot get different answers.

Regenerate after changing anything in \`grimoire-surface/src/\`:

    node grimoire-surface/scripts/vendor-site.mjs

Check for drift:

    node grimoire-surface/scripts/vendor-site.mjs --check
`;

const files = readdirSync(srcDir)
  .filter((f) => f.endsWith('.mjs'))
  .sort();

const problems = [];

for (const file of files) {
  const source = HEADER + readFileSync(join(srcDir, file), 'utf8');
  const target = join(outDir, file);
  if (check) {
    if (!existsSync(target)) problems.push(`${file} is missing from the vendored copy`);
    else if (readFileSync(target, 'utf8') !== source) problems.push(`${file} has drifted`);
  } else {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(target, source);
  }
}

const readmePath = join(outDir, 'README.md');
if (check) {
  if (!existsSync(readmePath)) problems.push('README.md is missing from the vendored copy');
} else {
  writeFileSync(readmePath, README);
}

const existing = existsSync(outDir) ? readdirSync(outDir).filter((f) => f.endsWith('.mjs')) : [];
for (const file of existing) {
  if (!files.includes(file)) problems.push(`${file} is vendored but no longer exists in the source`);
}

if (check) {
  if (problems.length) {
    console.error(`Vendored grimoire-surface is out of date:\n  ${problems.join('\n  ')}`);
    console.error('\nRegenerate with: node grimoire-surface/scripts/vendor-site.mjs');
    process.exit(1);
  }
  console.log(`vendored grimoire-surface is in step (${files.length} modules).`);
} else {
  console.log(`wrote ${files.length} modules to ${outDir}`);
  for (const p of problems) console.error(`  warning: ${p}`);
}
