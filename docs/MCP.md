# MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server over stdio. Eight tools, no
dependencies, no build step, no network access. It reads the corpus off disk.

---

## Setup

This repository deliberately contains **no data**. There are two ways to give the server a corpus.

**Option 1 — the bundle (no corpus repo needed).** One file, the whole corpus and its join table:

```bash
git clone https://github.com/formisfate/grimoire-surface.git
cd grimoire-surface
curl -L -o grimoire-bundle.json https://ensoul.so/api/grimoire/bundle
```

Point your client at `--bundle /absolute/path/to/grimoire-bundle.json` and you are done. This is the route for anyone who does
not have access to the corpus repository, and it is the same corpus — the file is built from the same
mirror the HTTP API serves, and both report the same content hash.

**Option 2 — a corpus checkout.** The `grimoire` repository is private, so this option is for people
who have been given access to it. Clone it beside this one:

```bash
git clone https://github.com/formisfate/grimoire-surface.git
git clone <corpus-repository-url-you-were-given> grimoire
```

Everything below works identically either way; the rest of this page does not assume which one you
used.

The server looks for the corpus in this order, and stops at the first hit:

1. `--bundle <file>` (highest precedence — an explicit file beats a directory search)
2. `--corpus <dir>`
3. `$GRIMOIRE_BUNDLE` / `$GRIMOIRE_DIR`
4. `../grimoire` — the sibling layout
5. `./grimoire` — a subdirectory of the current directory

If none exist it says so, lists every path it tried, and exits non-zero.

### Claude Code

```bash
claude mcp add grimoire -- node /absolute/path/to/grimoire-surface/mcp/server.mjs
```

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
`%APPDATA%\Claude\claude_desktop_config.json` on Windows:

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

### Cursor

`.cursor/mcp.json` in the project, or the global equivalent — same shape as Claude Desktop:

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

### Any other client

```bash
node mcp/server.mjs --corpus /path/to/grimoire
node mcp/server.mjs --bundle /path/to/grimoire-bundle.json
```

Speaks JSON-RPC 2.0, one message per line, on stdin/stdout. It answers `initialize`, `tools/list`,
`tools/call`, `ping`, and returns empty lists for `resources/list` and `prompts/list` so clients that
probe for them are satisfied. Diagnostics go to **stderr** only — stdout is protocol frames.

---

## Before you wire it up

```bash
node mcp/server.mjs --help
```

Then a real handshake, by hand:

```bash
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node mcp/server.mjs --corpus ../grimoire
```

You should get two JSON lines back and a line on stderr like:

```
[grimoire] corpus 3b0a6d255670 · 81 files · 3062 entries
```

If the stderr line says `corpus not loaded`, the handshake still succeeds — the error is reported on
the first tool call instead, where a client can actually show it to a human.

---

## The tools

### `grimoire_overview`

Nothing in, a description out. **Call this first** — it tells you what the corpus covers, whether
your question is even in scope, and how ids work. Cheap enough to call at the start of every
session.

### `grimoire_search`

| Arg | Type | Notes |
|---|---|---|
| `query` | string | required |
| `file` | string | restrict to one catalogue |
| `section` | string | restrict to one section |
| `limit` | number | default 20, max 200 |

Full-text, weighted. Names and ids score 10, keywords 5, the entry's one-liner 2, body text 1 — so
"protection" returns the working called *Protection* first, not the fifty entries that mention it.

Returns `mode: "all-terms"` when every word matched, `"any-term"` when the strict pass found nothing
and it widened.

### `grimoire_lookup`

| Arg | Type | Notes |
|---|---|---|
| `query` | string | required — an id, a name, or an alternative name |
| `file` | string | restrict to one catalogue |

The "I know what it is called" path. Tries id, then name, then alternate names, then falls back to
search and says so in `matched_by`.

Returns **every** entry carrying the id. `basil` gives three (herb, essential oil, incense resin);
`sage` gives four. That is deliberate — see [DATA.md](DATA.md#one-name-four-things).

### `grimoire_entry`

| Arg | Type | Notes |
|---|---|---|
| `id` | string | required |
| `file` | string | disambiguate |

The full record, unmodified, plus `references.out` (everything it points at, with the field and the
resolved targets) and `references.in` (everything that points at it, capped at 50 with the true
count in `in_count`).

### `grimoire_related`

| Arg | Type | Notes |
|---|---|---|
| `id` | string | required |
| `direction` | `both` / `out` / `in` | default `both` |
| `limit` | number | per field, default 100 |

The graph traversal, grouped by field. Use `out` to follow a chain forward — *what does Basil point
at* — and `in` to find everything that depends on something. Mars has 413 inbound references, which
is the whole corpus pointing at one planet.

### `grimoire_list`

| Arg | Type | Notes |
|---|---|---|
| `file` | string | a catalogue |
| `section` | string | a section |
| `limit`, `offset` | number | default 50, max 200 |

With no arguments: every file with its entry count. With `file`: every entry in it. `materials` in
`section` gives the eight material catalogues.

### `grimoire_timing`

| Arg | Type | Notes |
|---|---|---|
| `date` | string | ISO 8601; defaults to now |
| `latitude`, `longitude` | number | decimal degrees |
| `hemisphere` | string | inferred from latitude |

Planetary day, planetary hour, all 24 hours, moon phase, season, nearest sabbat.

Read `basis` and `caveats` before trusting an hour boundary. `basis: "location"` means real sunrise
and sunset for the coordinates; `basis: "approximation"` means a flat 6am/6pm, which can be a couple
of hours out.

### `grimoire_fits`

| Arg | Type | Notes |
|---|---|---|
| `date`, `latitude`, `longitude` | | as `/timing` |
| `moon_sign` | string | optional; skips the sign factor if absent |
| `limit` | number | default 10 |

Ranks the 49 core workings against the conditions. With no arguments it uses now, so "what should I
be doing right now" is one call. Every result carries its `factors` breakdown.

If you do not supply `moon_sign`, that factor is **skipped** rather than scored as a miss — so a
working is not penalised for your not knowing something.

---

## Reading the responses

Every tool returns the same envelope, plus `corpus.version`:

```json
{
  "corpus": { "version": "3b0a6d255670", "files": 81, "entries": 3062, "licence": "CC-BY-SA-4.0" },
  "…": "the answer"
}
```

### Provenance is not decoration

Compact results carry this block, always:

```json
"provenance": {
  "tradition": "folk_western",
  "culture": "mediterranean",
  "note": "Mars/Fire, the royal herb of protection…"
}
```

When `note` records a disagreement between sources, **repeat the disagreement**. Do not summarise
"the corpus says X is ruled by Mars" when the note says one tradition says Mars and another says
none. `untraced: true` means the entry has no provenance at all — a real gap in the data, and worth
saying out loud if you are relying on it.

### Errors are recoverable

A missing id is a **tool error** (`isError: true`) with a readable message and often a `hint`
listing near matches — not a protocol failure. Read it and try the hint; the session is fine.

---

## Troubleshooting

**"Could not find the grimoire corpus"** — you cloned one repo, not two. The message lists every
path it tried. Set `GRIMOIRE_DIR`.

**The client shows no tools** — check stderr. If the process exited, the most common cause is a
`node` that is too old (needs 18+) or a path typo in the config.

**Nothing comes back** — the server writes one JSON object per line and nothing else to stdout. If
anything else writes to stdout (a stray `console.log`, a shell profile echo) the client cannot parse
the stream and typically disconnects without an error.

**Everything is slow on the first call** — that is the corpus loading and the graph, search index and
reverse index being built: about 120 ms, once, then cached for the life of the process.
