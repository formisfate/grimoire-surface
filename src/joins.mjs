// The corpus's join-field semantics, read from `grimoire/joins.json`.
//
// The rule this file exists to encode: a value inside an entry is a reference to another entry
// ONLY when the corpus says so. It is not inferable from the field name, and inferring it has
// been tried and failed three separate times (`pairs_with`, then `gods`/`goddesses`, then the
// `*_gods` family — see `grimoire/AGENTS.md`). So the table is data, it lives with the corpus,
// and this module just applies it.
//
// The precedence is the corpus's own, recorded in `joins.json`:
//
//   not_joins   beats  scoped   beats   global
//
// - `not_joins` exists because a field can look exactly like a join and hold a vocabulary:
//   `moon_phases.direction` holds lunar-phase energies (`inward_seeding`), not compass points.
// - `scoped` exists because the same field name points opposite ways in two files: a planet's
//   `exaltation` is a sign, a sign's `exaltation` is a planet.
// - `global` is everything else.
//
// A value matching a meta value — `all`, `none_traditionally`, or anything beginning `all_` — is
// legal in any reference field and means "every member" or "none by tradition". It is NOT a
// missing id, and a consumer that treats it as one will report thousands of false failures.

export function createJoins(spec) {
  const metaValues = new Set(spec.meta_values ?? []);
  const notJoins = spec.not_joins ?? [];
  const scoped = spec.scoped ?? {};
  const global = spec.global ?? {};

  /** Values legal in a reference field that mean "everything" / "nothing", not an id. */
  const isMeta = (v) => typeof v === 'string' && (metaValues.has(v) || v.startsWith('all_'));

  /**
   * Is this field, in this file, at this path, deliberately not a join?
   * The corpus records sub-paths slash-prefixed (`/best_timing`); walkers here use dots.
   */
  const isNotJoin = (file, field, path = '') => {
    const p = path.replace(/\./g, '/');
    return notJoins.some(
      (n) => n.file === file && n.field === field && (n.sub === null || p.includes(n.sub.replace(/^\//, ''))),
    );
  };

  /**
   * What does this field reference? Returns `[targetFiles, resolveAgainstFiles]` or undefined.
   * `targetFiles[0]` is what the value nominally names; `resolveAgainst` is the union of files it
   * may legitimately resolve against — which is often wider, because a material field may name a
   * stone, a herb or a resin, and a deity field may name a planet.
   */
  const joinSpec = (file, field, path = '') => {
    if (isNotJoin(file, field, path)) return undefined;
    return scoped[`${file}|${field}`] ?? global[field];
  };

  return {
    metaValues,
    notJoins,
    isMeta,
    isNotJoin,
    joinSpec,
    containers: new Set(spec.containers ?? []),
  };
}
