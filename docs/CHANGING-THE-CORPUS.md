# Changing the corpus — every surface that has to move with it

The corpus is one dataset with seven things built on it, spread across three repositories. A change
that stops at the JSON leaves the rest quietly disagreeing: a page with no links, an API answering
from yesterday, a bundle nobody rebuilt, a count in a document that was true last week.

**One command answers whether everything still agrees:**

```bash
node scripts/check-all.mjs        # or: npm run check
```

It runs every guard — catalog counts, the generated join table, the vendored query surface, the test
suite, corpus↔mirror parity, the website graph's imports, and the website's own grimoire checks —
and names whatever is out of step. If you changed something and this passes, the surfaces agree.

---

## The map

```
  grimoire/                          ← the data. Canonical. Edit here FIRST, never in the mirror.
  ├── *.json            81 catalogues
  ├── joins.json        the join table  ──► generates ──► ensoul-web/src/lib/grimoire-joins.ts
  └── catalog.json      titles + counts
        │
        │ byte-identical copy
        ▼
  ensoul-public/ensoul-web/src/data/grimoire/        ← the website's mirror
        │
        ├──► grimoire-graph.ts     needs a col() line per catalogue, or no page and no links
        ├──► /grimoire/**          every entry at /grimoire/e/<id>
        ├──► /api/grimoire/*       the HTTP API, read from the mirror at runtime
        └──► /api/grimoire/bundle  the served bundle, built from the mirror

  grimoire-surface/                  ← the query code. Vendored into the website.
  ├── src/                ──► vendored ──► ensoul-web/src/vendor/grimoire-surface/
  ├── mcp/server.mjs      reads grimoire/ (or a bundle) at runtime
  └── scripts/            bundle, the two generators, the vendorer, check-all
```

---

## What you changed → what to run

### An entry — added, edited or culled

```bash
node scripts/gen-catalog.mjs                 # if the entry count moved
cp ../grimoire/<file>.json ../ensoul-public/ensoul-web/src/data/grimoire/
node scripts/check-all.mjs
```

Nothing else. Entries are read at runtime, so the API, the bundle and the MCP server all pick the
change up on the next request — but only once the site is redeployed (below).

### A new catalogue file — the change that bites

Four things, and missing any one of them fails silently in a different way:

```bash
# 1. describe it (the generator does not invent titles or sections)
#    add {file, key, title, section, glyph, browse_href, entries, system_entries} to grimoire/catalog.json
node scripts/gen-catalog.mjs

# 2. declare its join fields in grimoire/joins.json, then:
node scripts/gen-joins.mjs

# 3. mirror it
cp ../grimoire/<file>.json ../ensoul-public/ensoul-web/src/data/grimoire/

# 4. import it in ensoul-web/src/lib/grimoire-graph.ts — a `col()` line
#    (without this: no page, no links, invisible to a reader, and every check used to stay green)

node scripts/check-all.mjs
```

Steps 3 and 4 are the two that historically had no guard. They now fail `check-all` explicitly.

### The join table — `grimoire/joins.json`

```bash
node scripts/gen-joins.mjs                   # regenerate the website's TypeScript
cp ../grimoire/joins.json ../ensoul-public/ensoul-web/src/data/grimoire/
node scripts/check-all.mjs
```

A change here moves the corpus version hash, so every API response's `ETag` changes too. That is
correct — it *is* a different corpus. **Never hand-edit `grimoire-joins.ts`**; it is generated, and
editing it means the site and the MCP server disagree about what a reference is.

### The query surface — `grimoire-surface/src/`

```bash
node scripts/vendor-site.mjs                 # copy into the website
node scripts/check-all.mjs
```

The MCP server needs no build; a running one reloads on restart. The website needs a rebuild and a
restart to pick up the vendored change.

### The MCP tools — `grimoire-surface/src/tools.mjs`

Re-vendor as above, and check these three still describe the same interface:

- `docs/MCP.md` — the tool reference
- `ensoul-public/ensoul-web/src/pages/grimoire/developers.astro` — the public page
- `ensoul-public/ensoul-web/public/llms.txt` — what agents read without a client

The API's `/api/grimoire/tools` endpoint serves the same definitions, so it follows automatically.

### Anything a reader is told

Numbers and endpoints are quoted in several places. Grep before you assume:

```bash
grep -rn "34,999\|3,083\|81 catalogues" --include=*.md --include=*.astro --include=*.txt \
  grimoire grimoire-surface ensoul-public/ensoul-web/public ensoul-public/ensoul-web/src/pages/grimoire
```

Two rules learned the hard way: **derive a number where you can** (the grimoire hub reads its
reference count from the graph; `/overview` reports the live figures), and **expect every
hand-written one to be wrong eventually** — the corpus's own docs claimed 3,085 entries and "~22,000
references" while holding neither.

### The published surfaces

The website is what publishes the API, the bundle and the pages. After the repos are pushed:

```bash
ssh root@$DROPLET 'cd /root/ensoul-public && git pull -q --ff-only && cd ensoul-web \
  && npm run build && systemctl restart ensoul-web'
```

`npm run build` runs `astro check`, the mirror check and the public-surface checks, and fails closed —
so a broken mirror stops the deploy instead of shipping. Verify afterwards with
`curl -s https://ensoul.so/api/grimoire/overview | python3 -c "import json,sys;print(json.load(sys.stdin)['stats'])"`.

### Access paths, not data

If how the corpus is *reached* changes — an endpoint, the bundle URL, the MCP command — these are the
places that carry it:

| Where | What it says |
|---|---|
| `grimoire-surface/README.md` | the three ways in |
| `grimoire-surface/docs/{MCP,API,DATA}.md` | the reference |
| `ensoul-public/.../grimoire/developers.astro` | the public page |
| `ensoul-public/ensoul-web/public/llms.txt` | what an agent reads first |
| `ensoul-lumen/lumen/grimoire-access.md` | how Lumen reaches it wherever she is |

---

## Repository boundaries

- **`grimoire/` is data and stays data.** No code. Its `AGENTS.md` is the authoring rulebook.
- **`grimoire-surface/` is code and holds no data.** It reads the corpus at runtime.
- **`ensoul-public/` contains a generated copy of both** — the mirror, the vendored query surface and
  the generated join table are all outputs. Edit the sources, regenerate, then commit the output in
  the same change.
- **`grimoire/` pushes to the droplet bare repo**, which mirrors to GitHub. The other two push to
  GitHub directly.

## The traps this file exists for

1. **The mirror check iterates the mirror.** A new corpus file that was never copied passes it. Use
   `check-all`, which compares the two file sets.
2. **The graph needs a `col()` line.** A mirrored file the graph does not import has no page and no
   links — visible to nothing.
3. **Never edit the mirror or the generated files.** Next regeneration reverts them, and until then
   the deployed app disagrees with the repo.
4. **Never infer a reference from a field name.** `joins.json` decides. This has been tried three
   times and failed three times.
5. **Never reformat a catalogue.** One entry per line is the house style; a `JSON.stringify(…, 2)`
   turns a 64-line change into 1,693 and collides with every other agent in the tree.
6. **A green check is not a deployment.** The API answers from the droplet's build, not from your
   laptop.
