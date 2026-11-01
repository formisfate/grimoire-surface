// The tools, as data.
//
// Kept separate from the transport because this is the part that is actually the interface: an
// agent decides what to call by reading these descriptions, so they are written to be understood
// cold, by something that has never heard of this corpus. The same list is used to generate the
// API reference and the conformance tests, so the docs cannot describe tools that do not exist.

export const TOOLS = [
  {
    name: 'grimoire_overview',
    description:
      'Start here. Describes what the Grimoire corpus is, how it is organised (81 files, one symbolic system each), how many entries it holds, and how ids and cross-references work. Call this once before asking anything else, so you know whether the corpus covers the question at all.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'grimoire_search',
    description:
      'Full-text search for the idea when you do not know the exact file or name. Use this when you have a word or phrase — "protection", "funerary", "vanishing" — and want to find the entries that discuss it. Weighted so that names and ids outrank incidental mentions in body text. Returns compact entries with provenance and a URL.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for. One or two words works best.' },
        file: {
          type: 'string',
          description: 'Optional. Restrict to one catalogue, e.g. `herbs.json` or just `herbs`.',
        },
        section: {
          type: 'string',
          description:
            'Optional. Restrict to one section of the archive: elements, celestial, divination, forces, esoteric, materials, workings, foundations, oracles.',
        },
        limit: { type: 'number', description: 'Maximum results (default 20, max 200).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'grimoire_lookup',
    description:
      'Resolve a name or id to entries — the direct path when you already know what it is called ("Lilith", "the Tower", "jupiter", "new moon"). Tries id, then name, then alternative names, then falls back to search. An id can name more than one entry (`sage` is an archetype, a herb and a resin; `basil` is a herb, an oil and a resin), and every match is returned rather than a silently chosen favourite.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'An id, a name, or an alternative name.' },
        file: { type: 'string', description: 'Optional. Restrict to one catalogue.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'grimoire_find',
    description:
      'Filter entries by the values in their fields — the structured query, as opposed to full-text search. Ask "which herbs are ruled by Mars and run on fire?", "every tier-1 stone", "which workings call for Venus?". `where` maps a field to the value(s) it must hold; use dots for nested fields (`optimal_timing.planets`). Multiple fields are ANDed unless `match` is "any". Values match case-insensitively in either the id form or the display form ("new moon" finds `new_moon`). Returns matches as compact entries plus the true `total`, so you can page. This filters what the corpus says; it does not follow references — use `related` or `path` for the graph.',
    inputSchema: {
      type: 'object',
      properties: {
        where: {
          type: 'object',
          description:
            'Field → value, e.g. {"planet":"mars","element":"fire"}. A value may be an array meaning any-of for that field. Call `list` to see the catalogues, or make a call with a wrong field and the error lists the real ones.',
        },
        file: { type: 'string', description: 'Optional. Restrict to one catalogue, e.g. `herbs.json` or `herbs`.' },
        section: {
          type: 'string',
          description:
            'Optional. Restrict to one section: elements, celestial, divination, forces, esoteric, materials, workings, foundations, oracles.',
        },
        match: {
          type: 'string',
          enum: ['all', 'any'],
          description: '`all` (default) requires every field to match; `any` requires at least one.',
        },
        limit: { type: 'number', description: 'Maximum entries to return (default 50, max 200).' },
        offset: { type: 'number', description: 'Skip this many matches, for paging through a long set.' },
      },
      required: ['where'],
      additionalProperties: false,
    },
  },
  {
    name: 'grimoire_entry',
    description:
      'The full record for one entry, plus everything it references and everything that references it. Use this after search or lookup has told you the id. Returns the entry exactly as the corpus holds it — every field, its `tradition` and `note` — with `_meta` for addressing and a `references` block holding both directions of the graph. When an id names more than one entry (`sage` is four different things), `records` holds all of them in full rather than only the first.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The entry id, e.g. `basil`, `tower`, `mars`, `new_moon`.' },
        file: { type: 'string', description: 'Optional. Disambiguate when an id lives in several files.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'grimoire_related',
    description:
      'Traverse the graph from one entry: what it points at, grouped by field, and what points back at it. Use `direction` to take one side only. This is one hop — for a chain longer than that, use `path`.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The entry id to start from.' },
        direction: {
          type: 'string',
          enum: ['both', 'out', 'in'],
          description: '`out` = what it references, `in` = what references it, `both` (default).',
        },
        limit: { type: 'number', description: 'Maximum entries per field (default 100).' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'grimoire_path',
    description:
      'How two entries are connected: the shortest chain of references between them, with the field that makes each link. This is the multi-hop question a single `related` call cannot answer — "how does Basil connect to Aries?" comes back as basil —planet→ mars —zodiac→ aries, and `direction: "both"` (the default) is what lets the chain turn around, since the workings that call for basil point *at* it. Returns up to `max_paths` shortest paths and the hop count; if nothing is found within `max_depth` it says so rather than implying they are unrelated.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'The id to start from.' },
        to: { type: 'string', description: 'The id to reach.' },
        direction: {
          type: 'string',
          enum: ['both', 'out', 'in'],
          description:
            '`both` (default) follows references in either direction; `out` only what each entry points at; `in` only what points at it.',
        },
        max_depth: { type: 'number', description: 'Maximum hops to search (default 4, max 6).' },
        max_paths: { type: 'number', description: 'Maximum shortest paths to return (default 3, max 10).' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
  },
  {
    name: 'grimoire_list',
    description:
      'List the collections, or the entries inside one. Use it to see the shape of the corpus before narrowing, or to enumerate a whole catalogue (all 142 stones, all 64 I Ching hexagrams). With no arguments it returns every file with its entry count.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Optional. A catalogue, e.g. `stones.json` or `stones`.' },
        section: { type: 'string', description: 'Optional. A section of the archive, e.g. `materials`.' },
        limit: { type: 'number', description: 'Maximum entries to return (default 50, max 200).' },
        offset: { type: 'number', description: 'Skip this many entries, for paging through a long list.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'grimoire_timing',
    description:
      'The symbolic conditions right now — or at any given moment. Returns the planetary day and the planetary hour (Chaldean sequence from sunrise), the current hour among all 24, the moon phase, the season, the nearest sabbat, and the day/night hour table. Supply latitude and longitude for real sunrise/sunset; without them the day is divided at a flat 6am/6pm and the response says so.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Optional ISO 8601 instant. Defaults to now.' },
        latitude: { type: 'number', description: 'Optional. Decimal degrees, south negative.' },
        longitude: { type: 'number', description: 'Optional. Decimal degrees, west negative.' },
        hemisphere: { type: 'string', enum: ['northern', 'southern'], description: 'Optional. Inferred from latitude when omitted.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'grimoire_fits',
    description:
      'Rank the corpus\'s 49 core workings against a set of conditions: which rites, spells and observances the corpus says suit this day, this hour, this moon, this season. With no arguments it uses the current timing, making "what should I be doing right now" one call. Every result carries the score breakdown so you can see why it ranked where it did.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Optional ISO 8601 instant. Defaults to now.' },
        latitude: { type: 'number', description: 'Optional. Improves the planetary-hour calculation.' },
        longitude: { type: 'number', description: 'Optional.' },
        moon_sign: { type: 'string', description: 'Optional. The zodiac sign the moon is in, if you know it. Otherwise the sign factor is skipped.' },
        limit: { type: 'number', description: 'Maximum workings to return (default 10).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'grimoire_when',
    description:
      'The forward-looking half of timing: what is coming, and when. Returns the next full moon, new moon and quarters (dates, not almanac times), every sabbat within the horizon, and — if you name one — the next hour of a planet. Name a working and it returns the hours in the coming days where that working\'s own election fits best, ranked, with the reasons. Use this for "when should I do X" and "how long until Y"; `grimoire_timing` answers only "now".',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Optional ISO 8601 instant to look forward from. Defaults to now.' },
        days: { type: 'number', description: 'How far ahead to look, in days (default 30, max 90).' },
        latitude: { type: 'number', description: 'Optional. Decimal degrees, south negative. Improves hour boundaries.' },
        longitude: { type: 'number', description: 'Optional.' },
        hemisphere: { type: 'string', enum: ['northern', 'southern'], description: 'Optional. Inferred from latitude when omitted.' },
        planet: {
          type: 'string',
          enum: ['sun', 'moon', 'mars', 'mercury', 'jupiter', 'venus', 'saturn'],
          description: 'Optional. Return the next hour ruled by this planet.',
        },
        daylight_only: { type: 'boolean', description: 'Optional. Only count hours between sunrise and sunset.' },
        phase: {
          type: 'string',
          description:
            'Optional. One moon phase id — full_moon, new_moon, first_quarter, last_quarter, waxing_crescent, waxing_gibbous, waning_gibbous, waning_crescent. Defaults to the four cardinal ones. An array is also accepted.',
        },
        working: { type: 'string', description: 'Optional. A `core_workings` id, e.g. `protection`. Returns the best windows for it in the horizon.' },
        limit: { type: 'number', description: 'Maximum windows to return when `working` is given (default 5, max 20).' },
      },
      additionalProperties: false,
    },
  },
];

export const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));
