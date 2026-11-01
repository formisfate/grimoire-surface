# MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server over stdio. Eleven tools, no
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

### `grimoire_find`

| Arg | Type | Notes |
|---|---|---|
| `where` | object | required — field → value(s) |
| `file` | string | restrict to one catalogue |
| `section` | string | restrict to one section |
| `match` | `all` / `any` | default `all` |
| `limit`, `offset` | number | default 50, max 200 |

The structured query: not "what mentions Mars" but "what *is* Mars- ruled". Fields are ANDed, so
`{"element":"fire","planet":"mars","tier":1}` is the seven herbs that are all three. A value may be
an array meaning any-of for that field; a dotted key reaches into a nested object, which is where
the timing rules live (`{"optimal_timing.planets":"venus"}`).

Matching is case-insensitive and accepts either form of a value: `"new moon"` finds `new_moon`, and
`"Mars"` finds `mars`.

```json
{ "where": { "planet": "mars" }, "file": "herbs" }
```

Returns the matches as compact entries plus `total` — the true count, not the page — so a caller can
page or just report "52 herbs". An unknown field is an error that lists the fields that do exist:
a typo would otherwise read as "nothing matches".

`find` does **not** follow references. `{"planet":"mars"}` finds the herbs whose own `planet` field
says Mars; the *workings* that call for Mars are reached with `related` or `path`.

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

When the id names more than one entry — `sage` is four different things — `records` holds **all** of
them in full, each with its own references, and `records_count` says how many. `entry` stays the
first so existing readers keep working; do not treat it as the whole answer when `ambiguous` is
true. 193 ids are shared like this.

### `grimoire_related`

| Arg | Type | Notes |
|---|---|---|
| `id` | string | required |
| `direction` | `both` / `out` / `in` | default `both` |
| `limit` | number | per field, default 100 |

The graph traversal, grouped by field. Use `out` to follow a chain forward — *what does Basil point
at* — and `in` to find everything that depends on something. Mars has 413 inbound references, which
is the whole corpus pointing at one planet. This is **one hop**; for a chain, use `path`.

### `grimoire_path`

| Arg | Type | Notes |
|---|---|---|
| `from`, `to` | string | required — entry ids |
| `direction` | `both` / `out` / `in` | default `both` |
| `max_depth` | number | default 4, max 6 |
| `max_paths` | number | default 3, max 10 |

How two entries are connected: the shortest chain of references, with the field that makes each link.

```json
{ "from": "basil", "to": "protection" }
```

```text
basil —planet→ mars —planets(in)→ protection      2 hops
```

That second edge is a **backlink** — the working points at Mars, not the other way round — which is
why `direction` defaults to `both`. A strict forward walk cannot answer the corpus's own headline
question, because a real chain turns around. Set `out` to insist on forward references only.

This pair has **five** shortest paths, all true: through Mars, through fire, through a herb it pairs
with, and through two zodiac signs. The default returns the first 3; `max_paths` raises it. Showing
one and hiding the rest would be a smaller answer than the corpus holds.

`found: false` means "no chain within this depth", not "unrelated": 383 of the corpus's 3,071
entries carry no reference in either direction, and the tarot cards are one such island. The
response says so in `caveats` and offers a `hint` for widening the search.

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
and sunset for the coordinates; `basis: "approximation"` means a flat 6am/6pm **in the server's time
zone**, which is only close to the truth if you are near it. Pass coordinates for hour boundaries
that mean anything locally.

### `grimoire_when`

| Arg | Type | Notes |
|---|---|---|
| `from` | string | ISO 8601; defaults to now |
| `days` | number | how far ahead, default 30, max 90 |
| `latitude`, `longitude` | number | improves hour boundaries |
| `planet` | string | `sun` … `saturn` — the next hour of that planet |
| `daylight_only` | boolean | skip night hours |
| `phase` | string | one phase id; defaults to the four cardinal ones |
| `working` | string | a `core_workings` id — returns the best windows for it |
| `limit` | number | windows to return, default 5, max 20 |

The forward half of `timing`. `timing` answers *what is true now*; this answers *when*, which is the
next question people ask and the one nothing else in the corpus could answer.

```json
{ "from": "2026-10-31T20:00:00+11:00", "days": 30, "planet": "venus", "working": "protection" }
```

```text
moon.next   last_quarter 2026-11-02 · new_moon 2026-11-09 · first_quarter 2026-11-17 · full_moon 2026-11-24
hour        venus, 19th hour (night), 4 hours away
windows     2026-11-03 mars 100% · 2026-11-07 saturn 100% · 2026-11-28 saturn 100%
```

Three things it is careful about:

- **Phase dates are the middle of the phase window** — conjunction for new, opposition for full — on
  the mean synodic month, so they are accurate to about a day and will not match an almanac. The
  `caveats` say so.
- **Windows are the best hour of each day**, not every hour above a threshold. Returning the top
  thirty hours outright would answer "when should I do this" with a pile of adjacent afternoons.
- **The weekday is the instant's, not the planetary cycle's.** A 5am hour is still inside the
  previous sunrise-to-sunrise cycle, but `fits` scores the calendar weekday, so scoring the cycle
  here would make the two verbs disagree about the same moment. Each window echoes
  `conditions.weekday` so the answer explains itself.

`working` windows skip the moon-sign factor (there is no ephemeris here), so percentages rank
against each other within one response rather than against the website's absolute scores.

An empty `sabbats` array is a real answer: it means no festival falls in the horizon, not that the
lookup failed.

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

The **Day** factor compares the weekday name (`saturday`), which is what the corpus's
`optimal_timing.days` holds, and `conditions` reports both `weekday` and `planetary_day` so the two
cannot be confused. Before 2026-11-01 the surface passed the ruling planet (`saturn`) instead, which
meant the heaviest factor could never match and every working was ranked without it.

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
