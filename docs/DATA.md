# Using the data directly

If you want the corpus as JSON rather than as an API, this is what you need to know to use it
correctly. Most of it is one idea: **a value is a reference only when the corpus says so**, and the
corpus says so in `joins.json`.

Download the bundle, or build it from a corpus checkout:

```bash
curl -L -o grimoire-bundle.json https://ensoul.so/api/grimoire/bundle   # ~4 MB, always current
npm run bundle                                    # or build it yourself
```

```
dist/grimoire.json         6.2 MB   pretty-printed, for reading
dist/grimoire.min.json     4.2 MB   for shipping
dist/grimoire.min.json.gz  1.0 MB   for shipping over a network
dist/SHA256SUMS
```

---

## Shape

```json
{
  "meta": {
    "corpus": "3b0a6d255670",
    "files": 81,
    "entries": 3083,
    "licence": "CC BY-SA 4.0",
    "attribution": "The Grimoire corpus — https://ensoul.so/grimoire"
  },
  "catalog": { "files": [ { "file": "herbs.json", "title": "Herbs", "section": "materials", "entries": 259 } ] },
  "joins": { "global": { … }, "scoped": { … }, "not_joins": [ … ], "meta_values": [ … ] },
  "data": {
    "herbs.json": [ { "id": "basil", "name": "Basil", "planet": "mars", … } ],
    "planets.json": [ { "id": "mars", "name": "Mars", … } ]
  }
}
```

`meta.entries` (3,083) counts every entry including the 21 system/reference front-matter objects;
`catalog` counts exclude them, so the catalogue totals 3,062. That difference of 21 is why the numbers
in different places will not match, and it is not a bug.

Each file is a JSON **array** of entries, each with a string `id`, unique within its file.

---

## The one rule

**Do not infer references from field names.** This has been tried three times and failed each time,
which is why the corpus ships a table instead.

`joins.json` has three levels, applied in this order:

| | Meaning |
|---|---|
| `not_joins` | `[{file, field, sub, why}]` — fields that look like joins and are not. Wins over everything. |
| `scoped` | `"file.json\|field"` → `[target, resolveAgainst]` — the same field name means different things in different files. |
| `global` | `field` → `[target, resolveAgainst]` — everything else. |

`resolveAgainst` is often wider than `target`: a `stones` value may resolve against `stones.json`,
`herbs.json` or `incense_resins.json`, because a material field legitimately names any of them.

Worked examples:

```js
// planets.json's `exaltation` is a sign; zodiac.json's `exaltation` is a planet.
joins.scoped['planets.json|exaltation']   // ["zodiac.json", ["zodiac.json"]]
joins.scoped['zodiac.json|exaltation']    // ["planets.json", ["planets.json"]]

// `direction` is a join almost everywhere — but not on a moon phase, where it is an energy.
joins.not_joins.find(n => n.file === 'moon_phases.json' && n.field === 'direction')
// { why: "lunar-phase energy vocabulary, not compass directions" }
```

---

## Meta values

A value beginning `all_`, or one of `meta_values`, is **legal in any reference field** and means
"every member" or "none by tradition". It is not a broken id.

```json
"secondary_chakra": ["all_chakras"]
"day_of_week": "none_traditionally"
```

The `all_` **prefix is the rule**, not a list of spellings — anything starting `all_` is a meta
value. A consumer that treats these as missing ids will report thousands of false failures; that is
the single most common way to misread this corpus.

---

## One name, four things

Ids are unique within a file, **not across the corpus**. `basil` is a herb, an essential oil and an
incense resin — the same substance in three forms, deliberately sharing an id because *the id is the
substance and the file is the form*. `sage` is an archetype, a herb, a resin and an oil.

So: resolve an id to a **list**, and show the file to the reader.

The one case that is not at the top level is the tarot suits (`wands`, `cups`, `swords`,
`pentacles`), which are `id`s of the four objects inside `tarot_system.suits` in
`tarot_complete.json`. 160 references across the corpus name them, and they have no page of their
own.

---

## The five ways people get this wrong

1. **Treating every string as a reference.** `elements.tools` contains `self`, `the_center` and
   `the_circle_itself` — the aether tools *are* the circle and its centre. They are meant.
2. **Treating meta values as missing ids.** See above.
3. **Merging the second systems.** `phase` is Wu Xing (wood, fire, earth, metal, water); `element`
   is the Western five plus aether. They are different systems and must not be reconciled.
   Likewise `element` on a tarot court card is a Golden Dawn compound (`air_of_fire`) and is not a
   member of `elements.json`.
4. **"Fixing" a disagreement.** Basil is `element: fire` (Mars rules it) and `chakra: heart_chakra`
   (what it is used for). 88% of entries with both disagree. That is the design: element is what a
   thing runs on, chakra is where it acts. Do not derive one from the other.
5. **De-duplicating an array.** `planetary_hours.day_hours` is a 12-slot Chaldean sequence where a
   repeated planet is the point.

---

## Provenance

Provenance lives on the entry, not in a side table:

| Field | Where |
|---|---|
| `tradition` | most files, as a file-level default |
| `culture` | `deities.json` |
| `source` / `sources` | where a specific text is being cited |
| `origin` | `divination_methods.json` — where a method comes from, as distinct from how the corpus files it |
| `note` | **the caveat** — a modern overlay, a literary rather than cult figure, a retargeted value, a disagreement between sources |

If you redistribute, carry those fields. Dropping them turns a recorded disagreement into a false
assertion, which is the one thing this corpus is organised to avoid.

Coverage is not total, and that is recorded too: entries with no provenance at all are a known gap,
not an oversight, and the corpus's own audit numbers say so.

---

## Licence

**CC BY-SA 4.0.** Use it, adapt it, ship it, sell it — attribute it and share adaptations under the
same licence.

The underlying facts belong to nobody: this is drawn from Agrippa, the Golden Dawn's Book T, the
Arbatel, the Key of Solomon and Liber 777, most of it centuries out of copyright. What the licence
covers is the selection, the structure, the 34,999 cross-references, and the editorial work of
recording where each claim comes from and where traditions disagree.

A mention that travels is what the licence asks for in practice:

> The Grimoire corpus — https://ensoul.so/grimoire — CC BY-SA 4.0
