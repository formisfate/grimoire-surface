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

The `stats` block is the health check: `entries: 3062`, `references: 34936`,
`dangling_references: 1`. Anything else in `dangling_references` over time means the corpus has a
broken join.

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

```bash
curl 'https://ensoul.so/api/grimoire/timing?lat=-33.87&lon=151.21'
```

Returns `planetary_day`, `planetary_hour` (with all 24 hours in `hours`), `sunrise`, `sunset`,
`moon`, `season`, `time_of_day`, `sabbat`, and — importantly — **`basis`** and **`caveats`**.

`basis: "location"` means sunrise and sunset were computed for the coordinates you gave.
`basis: "approximation"` means you gave none, so the day was divided at a flat 6am/6pm, which can be
hours out. The response says which it used rather than quietly mixing them.

The moon phase is computed from the mean synodic month: good to about a day, fine for "which phase
are we in", not an ephemeris.

---

## `GET /fits`

Rank the corpus's 49 core workings against the conditions.

| Param | Default | Notes |
|---|---|---|
| `date`, `lat`, `lon` | now | As `/timing` |
| `moon_sign` | — | If you know it. Without it the sign factor is **skipped**, not failed. |
| `limit` | `10` | |

```bash
curl 'https://ensoul.so/api/grimoire/fits?lat=-33.87&lon=151.21&limit=5'
```

```json
{
  "conditions": {
    "planetary_day": "saturn", "planetary_hour": "moon",
    "moon_phase": "waning_gibbous", "moon_sign": null,
    "season": "spring", "time_of_day": "evening", "sabbat": "samhain"
  },
  "workings": [
    { "id": "divination", "name": "Divination", "percentage": 64,
      "factors": [ { "name": "Hour", "weight": 20, "matched": true, "points": 20 } ] }
  ]
}
```

The weights are the website's own, so the ranking here and the ranking at
`ensoul.so/grimoire/workings` are the same: day 25, moon 25 (−10 if the phase is one to avoid),
hour 20, season 15, moon sign 10, time of day 10, sabbat bonus 15. The `factors` array is the
breakdown, so you can see *why* something ranked where it did rather than trusting a number.

---

## `GET /tools`

The MCP tool definitions, as JSON. Useful if you are building an agent and want the same schemas.

---

## Self-hosting

The API runs as an Astro route inside the website (`src/pages/api/grimoire/[...path].ts`), over the
site's bundled corpus mirror, using the code in `src/vendor/grimoire-surface/`. To run it yourself,
run the website; there is no separate service to deploy.

If you would rather not run a server at all, the MCP server and the bundle cover the same ground.
