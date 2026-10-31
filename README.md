# grimoire-surface

A query surface for the **Grimoire** — a hand-curated corpus of 81 JSON files of esoteric and
metaphysical reference data: planets, deities, tarot, runes, chakras, stones, herbs, the tree of
life, the I Ching, the Shem HaMephorash, Ifá, Jyotisha, and more. 3,083 entries, 34,936
cross-references, every one of them resolving.

The corpus is the interesting part and it lives elsewhere. This repo is what makes it answerable.

**Three ways in, and you only need one:**

| You want to… | Use | Setup |
|---|---|---|
| Ask an AI assistant about correspondences | [MCP server](#1-mcp--for-ai-assistants) | one line of JSON |
| Query it from code or a website | [HTTP API](#2-http-api--for-code) | nothing — it's already live |
| Have the whole thing offline | [download bundle](#3-download-bundle--for-everything-else) | one file |

---

## Why this exists

A `git clone` already gives you the tables. What it does not give you is the thing the tables are
for:

- **The graph.** Entries reference each other by id — a stone says which planet rules it, a deity
  says which herbs are its own, a working says which hour supports it. 34,936 edges, all resolved.
  Ask *what connects Basil to Mars to Aries to the workings that call for it* and get an answer in
  one step.
- **Provenance that survives.** Every entry carries `tradition`, `culture`, `source` and — where the
  sources disagree — a `note`. This corpus does **not** pick a winner between traditions. A
  response that dropped those fields would turn "Agrippa says" into "is", so they are never dropped.
- **A stated join table.** Whether a value is a reference to another entry or just a word is
  declared in [`joins.json`](../grimoire/joins.json), not guessed from field names. That distinction
  matters: `sage` is four different entries, `element` means Wu Xing in one file and the Western five
  in another, and `exaltation` means opposite things in `planets.json` and `zodiac.json`.
- **Timing.** Planetary day, planetary hour, moon phase, season, nearest sabbat — and the corpus's
  49 workings ranked against them. This is the only part that is not derivable by reading, which is
  why it cannot live in a static file.

No dependencies. No build step. No network calls. It reads JSON off disk and answers.

---

## 1. MCP — for AI assistants

The MCP server is for anything that speaks the [Model Context Protocol](https://modelcontextprotocol.io):
Claude Code, Claude Desktop, Cursor, or your own agent.

### Get the corpus first

The corpus is a separate repository — this one contains no data:

```bash
git clone <grimoire-remote> grimoire
git clone <this-remote> grimoire-surface
```

Keep them side by side. The server finds `../grimoire` automatically.

### Claude Code

```bash
claude mcp add grimoire -- node /absolute/path/to/grimoire-surface/mcp/server.mjs
```

### Claude Desktop / Cursor / anything with a JSON config

```json
{
  "mcpServers": {
    "grimoire": {
      "command": "node",
      "args": ["/absolute/path/to/grimoire-surface/mcp/server.mjs"]
    }
  }
}
```

If the corpus is somewhere else, add an environment variable rather than relying on the lookup:

```json
{
  "mcpServers": {
    "grimoire": {
      "command": "node",
      "args": ["/absolute/path/to/grimoire-surface/mcp/server.mjs"],
      "env": { "GRIMOIRE_DIR": "/absolute/path/to/grimoire" }
    }
  }
}
```

Check it works before wiring it up:

```bash
node mcp/server.mjs --help
# or talk to it directly — one JSON message per line
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
  | node mcp/server.mjs
```

### The tools

| Tool | The question it answers |
|---|---|
| `grimoire_overview` | What is in here? Start with this. |
| `grimoire_search` | What mentions "protection"? |
| `grimoire_lookup` | What is Lilith / the Tower / Jupiter? |
| `grimoire_entry` | Give me the full record for `basil`, plus everything it references. |
| `grimoire_related` | What connects to Mars? |
| `grimoire_list` | Show me every stone / every hexagram. |
| `grimoire_timing` | What's the planetary hour right now? |
| `grimoire_fits` | What should I be doing under these conditions? |

Full reference, including what each returns and how to read it: **[docs/MCP.md](docs/MCP.md)**.

---

## 2. HTTP API — for code

Read-only, public, live, no key:

```bash
# what is in the corpus
curl https://ensoul.so/api/grimoire/overview

# find an entry
curl 'https://ensoul.so/api/grimoire/search?q=protection&limit=3'

# one entry in full, with its references in both directions
curl https://ensoul.so/api/grimoire/entry/basil

# what connects to it
curl 'https://ensoul.so/api/grimoire/related/mars?direction=in'

# timing, for a place and a moment
curl 'https://ensoul.so/api/grimoire/timing?lat=-33.87&lon=151.21'
```

Every response is JSON and carries `corpus.version` — the content hash of the exact corpus that
answered — plus an `ETag`, so you can cache and revalidate cheaply. CORS is open (`*`); it is
public reference data and identical for everybody.

Full endpoint reference: **[docs/API.md](docs/API.md)**.

---

## 3. Download bundle — for everything else

One file, the whole corpus, plus the join table that says how it fits together:

```bash
npm run bundle
# dist/grimoire.json         6.2 MB  (pretty, readable)
# dist/grimoire.min.json     4.2 MB
# dist/grimoire.min.json.gz  1.0 MB  (what to actually ship)
# dist/SHA256SUMS
```

The attribution and licence travel *inside* the file, because an unattributed copy of a CC BY-SA
work is a licence violation and the file is the one place that survives being moved around.

How to read the data — the join table, meta values, and the three ways people get it wrong:
**[docs/DATA.md](docs/DATA.md)**.

---

## Licence

Two licences, because there are two works here:

- **The code in this repository** — MIT. See [LICENSE](LICENSE).
- **The corpus** — CC BY-SA 4.0, in the [`grimoire`](../grimoire) repository. You may use, adapt and
  redistribute it, including commercially, as long as you attribute it and share adaptations under
  the same licence.

The corpus is largely drawn from public-domain sources — Agrippa, the Golden Dawn's Book T, the
Arbatel, the Key of Solomon, Liber 777 — and the underlying facts belong to nobody. What is
licensed is the selection, the structure, the cross-references and the editorial work of recording
where each claim comes from and where traditions disagree.

---

## Working on this repo

```bash
node test/run.mjs        # 35 checks: invariants, fixtures, and MCP driven over real stdio
npm run check            # the above, plus drift guards
```

`npm run check` fails if `grimoire/joins.json` has moved on, if `grimoire/catalog.json`'s entry
counts are stale, or if the copy of this code vendored into the website has drifted. Those three
are the invisible failures: everything keeps working and quietly disagrees.

```
src/            the query core — corpus, graph, search, timing, formatting
mcp/server.mjs  the MCP stdio transport (JSON-RPC over newline-delimited stdio)
mcp/            nothing else; tools are defined in src/tools.mjs so both surfaces share them
scripts/        bundle builder, the two generators, the website vendorer
test/           fixtures with known answers + the suite
docs/           MCP.md, API.md, DATA.md
```

The website does not reimplement any of this. It vendors `src/` verbatim
([`scripts/vendor-site.mjs`](scripts/vendor-site.mjs)) and runs the same code against its own
bundled mirror, so an answer from the API and the same answer from MCP cannot differ. `npm run
check` proves it: the suite builds the surface from both data paths and compares the versions.

## Related

- [`grimoire`](../grimoire) — the corpus itself. The data, its rules, and its history.
- `ensoul.so/grimoire` — the browsable archive, every entry at `/grimoire/e/<id>`.
