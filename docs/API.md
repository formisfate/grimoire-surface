# HTTP API

Read-only, public, no key, no rate limit that you will ever hit. It is the same query core the MCP
server runs, over the same corpus, so the two cannot disagree.

Base URL: `https://ensoul.so/api/grimoire`

---

## Conventions

**Success** is `200` with a JSON body. Every response object contains:

```json
"corpus": {
  "version": "3b0a6d255670",
  "files": 81,
  "entries": 3062,
  "licence": "CC-BY-SA-4.0",
  "attribution": "The Grimoire corpus — https://ensoul.so/grimoire"
}
```

`version` is a content hash of the corpus that answered. Two identical versions mean two answers you
can compare; a different version means the corpus has changed under you.

**Errors** carry a stable `code`:

```json
{ "error": { "code": "not_found", "message": "No entry with the id `basilisk`.", "hint": "Did you mean: basilisk_lizard?" } }
```

| Status | `code` | Means |
|---|---|---|
| `400` | `bad_request` | A required parameter was missing or unreadable |
| `404` | `not_found` | The id or collection does not exist — `hint` suggests alternatives |
| `404` | `unknown_endpoint` | No such verb; the response lists every endpoint |
| `500` | `corpus_unavailable` | The server could not load its corpus — not your fault |

**Caching.** Every response carries `ETag: W/"<version>"`. If you send it back in `If-None-Match`
you get `304 Not Modified` and no body. `Cache-Control: public, max-age=300`.

**CORS.** `Access-Control-Allow-Origin: *`. Call it from anywhere.

---

## `GET /overview`

What the corpus is: sections, files, entry counts, reference counts, and how addressing works.

```bash
curl https://ensoul.so/api/grimoire/overview
```

The `stats` block is the health check: `entries: 3062`, `references: 34999`,
`dangling_references: 0`. Anything other than zero in `dangling_references` over time means the
corpus has a broken join.

---

## `GET /search`

Full-text search across every field of every entry, weighted so identifiers outrank body mentions.

| Param | Default | Notes |
|---|---|---|
| `q` | required | What to search for. One or two words works best. |
| `file` | — | Restrict to a catalogue: `herbs.json` or just `herbs` |
| `section` | — | Restrict to a section: `materials`, `celestial`, … |
| `limit` | `20` | Max 200 |

```bash
curl 'https://ensoul.so/api/grimoire/search?q=protection&limit=3'
```

```json
{
  "query": "protection",
  "mode": "all-terms",
  "count": 3,
  "results": [
    {
      "score": 50,
      "matched": ["protection"],
      "id": "protection",
      "name": "Protection",
      "file": "core_workings.json",
      "collection": "core_workings",
      "section": "workings",
      "summary": "…",
      "provenance": { "tradition": "folk_western" },
      "untraced": false,
      "url": "https://ensoul.so/grimoire/e/protection"
    }
  ]
}
```

`mode` is `all-terms` when every word in the query matched somewhere, or `any-term` when the strict
search found nothing and it widened. A `mode` of `any-term` is a signal that the query was loose.

---

## `GET /find`

Structured query: entries whose fields hold these values. Where `/search` ranks text, `/find` is
exact and returns a true total.

| Param | Default | Notes |
|---|---|---|
| `where` | required | A JSON object of field → value(s) |
| `file` | — | Restrict to a catalogue |
| `section` | — | Restrict to a section |
| `match` | `all` | `all` ANDs the fields; `any` ORs them |
| `limit` | `50` | Max 200 |
| `offset` | `0` | Paging; the response gives `next_offset` |

```bash
curl -G 'https://ensoul.so/api/grimoire/find' \
  --data-urlencode 'file=herbs' \
  --data-urlencode 'where={"planet":"mars","element":"fire"}'
```

```json
{
  "filters": {
    "file": "herbs",
    "section": null,
    "where": { "planet": "mars", "element": "fire" },
    "match": "all"
  },
  "total": 41,
  "offset": 0,
  "count": 41,
  "entries": [
    { "id": "basil", "name": "Basil", "file": "herbs.json", "provenance": { "tradition": "folk_western" } }
  ]
}
```

A value may be an array meaning any-of for that field. A dotted key reaches into a nested object,
which is where the timing rules live:

```bash
curl -G 'https://ensoul.so/api/grimoire/find' \
  --data-urlencode 'file=core_workings' \
  --data-urlencode 'where={"optimal_timing.planets":"venus"}'
```

Matching is case-insensitive and accepts either form, so `"new moon"` finds `new_moon`. An unknown
field returns `400 bad_request` with the fields that do exist in `hint` — a typo otherwise reads as
"nothing matches".

Matching is **exact** — equality, or an array meaning any-of. There are no substrings and no
comparison operators: `{"tier":">1"}` is refused with a 400 rather than quietly matching nothing.
Use `/search` for text. To see what is matchable, use `/fields`.

`find` matches values as written; it does not follow references. Use `/related` or `/path` for that.

---

## `GET /fields`

What `/find` can match, in a scope: every scalar field path, whether it is a list, how many entries
carry it, and example values. The corpus has over 1,300 matchable paths, so this is the way to find
out whether a field exists without guessing.

| Param | Default | Notes |
|---|---|---|
| `file` | — | Restrict to a catalogue |
| `section` | — | Restrict to a section |

```bash
curl 'https://ensoul.so/api/grimoire/fields?file=herbs'
```

```json
{
  "file": "herbs",
  "count": 11,
  "fields": [
    { "path": "planet", "type": "string", "multi": true, "entries": 259,
      "examples": ["mars", "sun", "venus"] },
    { "path": "tier", "type": "number", "multi": false, "entries": 259, "examples": [1, 2, 3] }
  ]
}
```

`multi: true` means the value is a list, so a single value matches if it is one of them.

---

## `GET /lookup`

Resolve a name to entries. Tries id, then name, then alternative names, then falls back to search.

| Param | Default | Notes |
|---|---|---|
| `q` | required | An id, a name, or an alternative name |
| `file` | — | Restrict to one catalogue |
| `limit` | `10` | |

```bash
curl 'https://ensoul.so/api/grimoire/lookup?q=basil'
```

`matched_by` says how it resolved: `id`, `name`, `alternate-name`, or `fuzzy:<mode>`.

> **One name can be several entries.** This is normal, not a defect. `basil` is a herb, an
> essential oil and an incense resin — the same substance in three forms — and `sage` is an
> archetype, a herb, a resin and an oil. The response returns all of them, sets `multiple_entries:
> true`, and leaves the choice to you rather than silently picking one.

---

## `GET /entry/:id`

The full record, plus everything it references and everything that references it.

| Param | Notes |
|---|---|
| `file` | Disambiguate when the id lives in more than one catalogue |

```bash
curl https://ensoul.so/api/grimoire/entry/basil
```

```json
{
  "entry": {
    "id": "basil",
    "name": "Basil",
    "planet": "mars",
    "element": "fire",
    "chakra": ["heart_chakra"],
    "…": "every field the corpus holds, unmodified",
    "_meta": {
      "file": "herbs.json",
      "collection": "herbs",
      "url": "https://ensoul.so/grimoire/e/basil",
      "provenance": { "tradition": "folk_western", "note": "Mars/Fire, the royal herb of…" },
      "untraced": false,
      "references_out": 12,
      "references_in": 79
    }
  },
  "references": {
    "out": [
      {
        "field": "planet",
        "path": "planet",
        "id": "mars",
        "resolves": true,
        "targets": [{ "id": "mars", "name": "Mars", "file": "planets.json", "…": "…" }]
      }
    ],
    "in_count": 79,
    "in": [{ "field": "herbs", "entry": { "id": "…", "name": "…" } }]
  }
}
```

The entry object is **not filtered**. Whatever the corpus holds is what you get, including `note`
and `tradition`. `references.in` is capped at 50 entries; `in_count` is the true total. Mars has
413 inbound references, which is why the cap exists.

When the id names more than one entry, the response sets `ambiguous: true` and adds `records` — every
one of them in full, each with its own `_meta` and references — plus `records_count`. `entry` remains
the first, so a caller that ignores ambiguity still works, but `records` is the complete answer.
`sage` is the four-entry case.

---

## `GET /related/:id`

The neighbourhood, grouped by field. This is the graph traversal — the thing a table dump cannot do.

| Param | Default | Notes |
|---|---|---|
| `direction` | `both` | `out`, `in`, or `both` |
| `limit` | `100` | Per field |

```bash
curl 'https://ensoul.so/api/grimoire/related/mars?direction=out'
```

```json
{
  "id": "mars",
  "name": "Mars",
  "out": {
    "deities": [{ "id": "ares", "resolves": true, "targets": [ … ] }],
    "element": [{ "id": "fire", "resolves": true, "targets": [ … ] }]
  },
  "in": {
    "planet": [{ "file": "herbs.json", "id": "basil", "name": "Basil", … }]
  }
}
```

`resolves: false` means the value names something the corpus has no entry for — a real, reportable
gap in the data, not a server problem.

---

## `GET /path/:from/:to`

How two entries are connected: the shortest chain of references between them, each step labelled
with the field that made it.

| Param | Default | Notes |
|---|---|---|
| `direction` | `both` | `out` = forward references only, `in` = backlinks only |
| `max_depth` | `4` | Max 6 |
| `max_paths` | `3` | Max 10 shortest paths |

```bash
curl 'https://ensoul.so/api/grimoire/path/basil/protection'
```

```json
{
  "from": { "id": "basil", "name": "Basil", "file": "herbs.json", "url": "https://ensoul.so/grimoire/e/basil" },
  "to": { "id": "protection", "name": "Protection", "file": "core_workings.json", "url": "…" },
  "direction": "both",
  "found": true,
  "length": 2,
  "paths": [
    {
      "length": 2,
      "nodes": [ { "id": "basil", "…": "…" }, { "id": "mars", "…": "…" }, { "id": "protection", "…": "…" } ],
      "edges": [
        { "from": "basil", "field": "planet", "direction": "out", "to": "mars" },
        { "from": "mars", "field": "planets", "direction": "in", "to": "protection" }
      ]
    }
  ],
  "explored": 81,
  "depth_searched": 4
}
```

The second edge in that example is a **backlink** — the working names its planets, Mars does not
name its workings — which is why `direction` defaults to `both`. Insist on `out` to follow only
forward references, as a strict chain.

`found: false` means **no chain within this depth**, not "unrelated". A `hint` says how to widen the
search, and `caveats` records the honest limit: 383 of the corpus's 3,071 entries carry no reference
in either direction — the tarot cards are one such island — so two things can be related in meaning
and still have no path.

---

## `GET /list`

Browse the catalogue of catalogues, or the entries in one.

| Param | Default | Notes |
|---|---|---|
| `file` | — | A catalogue |
| `section` | — | A section |
| `limit` | `50` | Max 200 |
| `offset` | `0` | Paging; the response gives `next_offset` |

```bash
curl 'https://ensoul.so/api/grimoire/list?file=stones&limit=5'
curl 'https://ensoul.so/api/grimoire/list'          # every file, with counts
```

---

## `GET /collections`

The files and sections alone, without entries — a cheap manifest for building a UI.

---

## `GET /timing`

The symbolic conditions at a moment.

| Param | Default | Notes |
|---|---|---|
| `date` | now | ISO 8601, e.g. `2026-10-31T20:00:00+11:00` |
| `lat`, `lon` | — | Decimal degrees; south and west negative |
| `hemisphere` | inferred | `northern` or `southern` |
| `time_zone` | — | IANA zone; weekday, time of day, season and sabbat dates are judged in it. Defaults to the server's |

```bash
curl 'https://ensoul.so/api/grimoire/timing?lat=-33.87&lon=151.21'
```

Returns `planetary_day`, `planetary_hour` (with all 24 hours in `hours`), `sunrise`, `sunset`,
`moon`, `season`, `time_of_day`, `sabbat`, and — importantly — **`basis`** and **`caveats`**.

`basis: "location"` means sunrise and sunset were computed for the coordinates you gave.
`basis: "approximation"` means you gave none, so the day was divided at a flat 6am/6pm **in the
server's time zone** — accurate only if you are near the server. The response says which it used
rather than quietly mixing them.

The moon phase is computed from the mean synodic month: good to about a day, fine for "which phase
are we in", not an ephemeris.

---

## `GET /when`

The forward-looking half of `/timing`: the next phases, the sabbats ahead, the next hour of a
planet, and the best windows for a working.

| Param | Default | Notes |
|---|---|---|
| `from` | now | ISO 8601 instant to look forward from |
| `days` | `30` | Horizon, max 90 |
| `lat`, `lon` | — | Improves hour boundaries |
| `planet` | — | `sun` … `saturn`; returns the next hour it rules |
| `daylight_only` | — | `true` to skip night hours |
| `phase` | — | One phase id; defaults to the four cardinal ones |
| `working` | — | A `core_workings` id; returns ranked windows |
| `limit` | `5` | Windows to return, max 20 |
| `time_zone` | — | IANA zone; weekday, time of day, season and sabbat dates are judged in it. Defaults to the server's |

```bash
curl -G 'https://ensoul.so/api/grimoire/when' \
  --data-urlencode 'from=2026-10-31T20:00:00+11:00' \
  --data-urlencode 'planet=venus' \
  --data-urlencode 'working=protection' \
  --data-urlencode 'days=30'
```

```json
{
  "at": "2026-10-31T09:00:00.000Z",
  "horizon_days": 30,
  "basis": "approximation",
  "moon": {
    "now": { "id": "waning_gibbous", "illumination": 72.2, "age_days": 18.9 },
    "next": [
      { "id": "last_quarter", "date": "2026-11-02T12:49:52.253Z", "days_away": 2.16, "illumination": 50 },
      { "id": "new_moon", "date": "2026-11-09T21:57:55.130Z", "days_away": 9.54, "illumination": 0 },
      { "id": "first_quarter", "date": "2026-11-17T07:05:07.130Z", "days_away": 16.92, "illumination": 50 },
      { "id": "full_moon", "date": "2026-11-24T16:12:19.130Z", "days_away": 24.3, "illumination": 100 }
    ]
  },
  "sabbats": [],
  "hour": { "planet": "venus", "number": 19, "day": false, "hours_away": 4 },
  "working": {
    "id": "protection",
    "name": "Protection",
    "windows": [
      { "date": "2026-11-03", "hour": { "planet": "mars" }, "percentage": 100,
        "matched": ["Day", "Moon", "Hour", "Season", "Time"],
        "conditions": { "weekday": "tuesday", "planetary_day": "mars", "moon_phase": "last_quarter" } }
    ]
  }
}
```

`sabbats: []` is a real answer — none falls in the horizon. An empty array is not an error.

Phase dates are the **middle** of the phase window on the mean synodic month, so they are good to
about a day and are not almanac times; the response says so in `caveats`.

Each window's `conditions.weekday` is the weekday of the **instant**, which is what `/fits` scores,
so the two verbs agree about the same moment even for a pre-dawn hour that still belongs to the
previous planetary cycle.

---

## `GET /fits`

Rank the corpus's 49 core workings against the conditions.

| Param | Default | Notes |
|---|---|---|
| `date`, `lat`, `lon` | now | As `/timing` |
| `moon_sign` | — | If you know it. Without it the sign factor is **skipped**, not failed. |
| `catalogue` | `workings` | `workings` or `talismans` |
| `time_zone` | — | IANA zone; weekday, time of day, season and sabbat dates are judged in it. Defaults to the server's |
| `limit` | `10` | |

```bash
curl 'https://ensoul.so/api/grimoire/fits?lat=-33.87&lon=151.21&limit=5'
```

```json
{
  "conditions": {
    "weekday": "saturday", "planetary_day": "saturn", "planetary_hour": "moon",
    "moon_phase": "waning_gibbous", "moon_sign": null,
    "season": "spring", "time_of_day": "evening", "sabbat": "samhain"
  },
  "workings": [
    { "id": "funeral", "name": "Funeral", "score": 80, "maxScore": 110, "percentage": 73,
      "factors": [
        { "name": "Day", "weight": 25, "matched": true, "points": 25 },
        { "name": "Hour", "weight": 20, "matched": false, "points": 0 }
      ] }
  ]
}
```

The weights are the website's own, so the ranking here and the ranking at
`ensoul.so/grimoire/workings` are the same: day 25, moon 25 (−10 if the phase is one to avoid),
hour 20, season 15, moon sign 10, time of day 10, sabbat bonus 15. The `factors` array is the
breakdown, so you can see *why* something ranked where it did rather than trusting a number.

`catalogue=talismans` ranks the seven planetary talismans under a `talismans` key instead. Only their
day and hour are scored, because those are the only elections the corpus states for them; the
percentages are not comparable with the workings'.

**`weekday` is what the Day factor compares**, because that is what `optimal_timing.days` holds; the
ruling planet is reported separately as `planetary_day`. Both are returned because they are easy to
confuse, and confusing them is exactly what happened: before 2026-11-01 the surface sent the planet,
the factor never matched, and every ranking was missing its heaviest signal.

---

## `GET /bundle`

The whole corpus in one file: every entry, the catalogue, and `joins.json`. About 4 MB of JSON,
served as an attachment.

```bash
curl -L -o grimoire-bundle.json https://ensoul.so/api/grimoire/bundle
```

The response carries `$schema: "grimoire-bundle/1"`, the licence and attribution in `meta`, and the
`data` object keyed by file name. It is built from the same mirror these endpoints read, so it cannot
be a different corpus from the one answering `/entry`.

This is the intended path for anything that wants the data rather than the API — including the MCP
server: `node mcp/server.mjs --bundle grimoire-bundle.json` runs the full surface from this one file,
with no corpus checkout.

`Content-Disposition` names it `grimoire-<version>.json`, so a saved copy states which corpus it is.

---

## `GET /tools`

The MCP tool definitions, as JSON. Useful if you are building an agent and want the same schemas.

---

## Self-hosting

The API runs as an Astro route inside the website (`src/pages/api/grimoire/[...path].ts`), over the
site's bundled corpus mirror, using the code in `src/vendor/grimoire-surface/`. To run it yourself,
run the website; there is no separate service to deploy.

If you would rather not run a server at all, the MCP server and the bundle cover the same ground.
