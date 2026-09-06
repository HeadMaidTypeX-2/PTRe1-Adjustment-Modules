/**
 * Evolution Requirements — gate level-up evolution options on the species item
 * ----------------------------------------------------------------------------
 * PTR's species sheet already has everything needed to describe a conditional
 * evolution, and none of it is enforced:
 *
 *   - An **Item** column per evolution row. Dropping an item there stores
 *     `evolution.other.evolutionItem = { slug, uuid }` (species/sheet.js:319).
 *     Nothing has ever read it back — `convertToPTUSpecies` even writes it as
 *     `undefined` (species/document.js:64).
 *   - A **Restriction** text column, stored as `evolution.other.restrictions`.
 *
 * The level-up list is built in LevelUpData#refresh()
 * (apps/level-up-form/document.js:184-219) and gated by
 * PokemonGenerator.isEvolutionRestricted(), which is inert twice over:
 *
 *   1. It reacts to exactly "male" / "female" and returns undefined (= allowed)
 *      for every other restriction string.
 *   2. The form calls it as `isEvolutionRestricted(evo, this.pokemon.gender)`,
 *      but the signature is `(stage, { gender } = {})` — a bare value where an
 *      object is destructured — and PTUPokemon has no `.gender` getter
 *      (`system.gender` is the real path). Gender gating works in NPC
 *      generation and has never worked on the level-up screen.
 *
 * Result: an Eevee at level 25 offered all 19 of its level-25 evolutions and
 * preselected one AT RANDOM.
 *
 * This module reads the species item's own fields and filters that list. There
 * is no per-species data table here — drop an item on the species sheet row and
 * it becomes a requirement.
 *
 * Presentation:
 *   - Players see only evolutions the Pokémon qualifies for.
 *   - A GM sees every evolution; unmet ones are disabled in the dropdown with
 *     the reason appended to the label.
 *
 * Default selection: exactly one qualifying evolution is preselected; several
 * means the form defaults to "stay as you are" so the choice is deliberate.
 * That is what replaces the random pick.
 *
 * Scope is the level-up screen only — random NPC generation is left alone.
 * Patch strategy: LevelUpData is not exported to game.ptu, so its prototype is
 * captured from the first rendered form via the renderLevelUpForm hook. No
 * system files are edited.
 */

const MODULE_ID = "PTRe1-Adjustment-Modules";

/**
 * Comparison key: lowercase, alphanumerics only. Collapses the difference
 * between an item's slug and the free-text held-item name, and between the
 * compendium's inconsistent restriction spellings:
 *   "Water Stone" / "water-stone"        -> "waterstone"
 *   "Thunderstone" / "Thunder Stone"     -> "thunderstone"
 */
const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/** "water-stone" -> "Water Stone", for player-facing reasons. */
const prettify = (slug) =>
  String(slug ?? "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

/** Console warnings are emitted once per species/evolution/tag, not per render. */
const warned = new Set();

const warnOnce = (key, message) => {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`${MODULE_ID} | ${message}`);
};

/* ─────────────────────────────── actor inspection ──────────────────────────── */

/**
 * The held item's comparison key, or null when nothing is held.
 * `system.heldItem` is a free-text field holding an item NAME ("None" = empty).
 */
function heldItemKey(actor) {
  const held = actor?.system?.heldItem;
  if (!held || held === "None") return null;
  return norm(held) || null;
}

/* ──────────────────────────── requirement evaluation ───────────────────────── */

/**
 * The item dropped onto this evolution row on the species sheet.
 * @returns {{key: string, label: string}|null}
 */
function itemRequirement(row) {
  const dropped = row?.other?.evolutionItem;
  if (!dropped) return null;

  const slug = dropped.slug ?? dropped.name;
  const key = norm(slug);
  if (!key) return null;

  return { key, label: prettify(slug) };
}

/**
 * One restriction string from the Restriction column.
 * @returns {{ok: boolean, reason?: string}}
 */
function checkRestriction(raw, actor, { speciesSlug, evolutionSlug, gmAllowed }) {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: true }; // "" is the system's own "no requirement"

  const key = norm(text);
  if (!key) return { ok: true };

  if (key === "male" || key === "female") {
    const actual = norm(actor?.system?.gender);
    if (actual === key) return { ok: true };
    return { ok: false, reason: `must be ${key}` };
  }

  if (key === "gm" || key === "gmpermission") {
    return gmAllowed ? { ok: true } : { ok: false, reason: "GM permission" };
  }

  // Anything else is treated as an item the Pokémon must be holding. This makes
  // the compendium's existing bare tags ("Thunderstone", "Ice Stone", "Fire
  // Stone", "Sweet") work as written, and fails closed on genuine typos.
  warnOnce(
    `${speciesSlug}/${evolutionSlug}/${key}`,
    `restriction "${text}" on ${speciesSlug} -> ${evolutionSlug} is not a known ` +
      `keyword; treating it as a held-item requirement. Drop the item on the ` +
      `species sheet's Item column instead to make this explicit.`
  );

  return heldItemKey(actor) === key
    ? { ok: true }
    : { ok: false, reason: `needs held ${prettify(text)}` };
}

/**
 * @param {boolean} gmAllowed whether "GM permission" counts as satisfied
 * @returns {{ok: boolean, reasons: string[]}}
 */
function evaluateEvolution(row, actor, speciesSlug, gmAllowed) {
  const reasons = [];
  const evolutionSlug = row?.slug;

  const required = itemRequirement(row);
  if (required && heldItemKey(actor) !== required.key) {
    reasons.push(`needs held ${required.label}`);
  }

  for (const entry of row?.other?.restrictions ?? []) {
    const result = checkRestriction(entry, actor, { speciesSlug, evolutionSlug, gmAllowed });
    if (!result.ok) reasons.push(result.reason);
  }

  return { ok: reasons.length === 0, reasons };
}

/* ───────────────────────────────── the filter ──────────────────────────────── */

/**
 * Annotates and filters data.evolutions.available, then corrects
 * data.evolutions.current if it points at something unavailable.
 *
 * @returns {boolean} true when `current` changed and stats need recomputing
 */
function applyRequirements(data) {
  const actor = data.pokemon;
  const speciesSlug = actor?.species?.slug;
  const evolutions = data.evolutions;
  if (!speciesSlug || !evolutions?.available?.length) return false;

  const rows = actor.species.system?.evolutions ?? [];
  const isGM = !!game.user?.isGM;

  for (const entry of evolutions.available) {
    // "Stay as you are" is never gated.
    if (entry.slug === speciesSlug) {
      entry.ptreBlocked = false;
      entry.ptreEarned = false;
      entry.ptreReasons = [];
      continue;
    }
    const row = rows.find((r) => r.slug === entry.slug);
    const { ok, reasons } = evaluateEvolution(row, actor, speciesSlug, isGM);
    entry.ptreBlocked = !ok;
    entry.ptreReasons = reasons;
    // Whether the Pokémon itself meets the conditions, ignoring GM privilege.
    // Preselection rides on this so a GM is not auto-evolved into whatever
    // single "GM permission" form a species happens to have.
    entry.ptreEarned = isGM
      ? evaluateEvolution(row, actor, speciesSlug, false).ok
      : ok;
  }

  // Players get the filtered list. A GM keeps the full list and sees blocked
  // entries disabled in the dropdown instead.
  if (!isGM) {
    const permitted = evolutions.available.filter((e) => !e.ptreBlocked);
    evolutions.available = permitted.length
      ? permitted
      : evolutions.available.filter((e) => e.slug === speciesSlug);
  }

  const earned = evolutions.available.filter(
    (e) => e.ptreEarned && e.slug !== speciesSlug
  );
  const selfEntry =
    evolutions.available.find((e) => e.slug === speciesSlug) ?? {
      uuid: actor.species.uuid,
      slug: speciesSlug,
      level: data.level?.current,
    };

  // One earned evolution preselects it; several means the player chooses, so
  // default to staying put rather than rolling one at random.
  const target = earned.length === 1 ? earned[0] : selfEntry;

  if (evolutions.current?.slug !== target.slug) {
    evolutions.current = target;
    return true;
  }
  return false;
}

/* ──────────────────────────────── the patch ────────────────────────────────── */

let patched = false;

function patchLevelUpData(proto) {
  if (!proto || proto.ptreEvolutionRequirementsPatched) return false;

  const original = proto.refresh;
  if (typeof original !== "function") {
    console.error(`${MODULE_ID} | LevelUpData#refresh not found; evolution gating NOT installed.`);
    return false;
  }

  proto.refresh = async function (...args) {
    const firstBuild = !this.evolutions;
    let result = await original.apply(this, args);

    if (firstBuild) {
      try {
        // Re-running refresh with evolutions already built skips the rebuild and
        // takes the branch that resyncs stats/moves/abilities to the new current.
        if (applyRequirements(this)) result = await original.apply(this, args);
      } catch (error) {
        console.error(`${MODULE_ID} | evolution requirement filtering failed`, error);
      }
    }

    return result;
  };

  proto.ptreEvolutionRequirementsPatched = true;
  console.log(`${MODULE_ID} | evolution requirements installed (LevelUpData#refresh).`);
  return true;
}

/** GM view: show every evolution, disable the ones the Pokémon does not qualify for. */
function annotateBlockedOptions(app, html) {
  if (!game.user?.isGM) return;

  const entries = app?.data?.evolutions?.available;
  if (!entries?.length) return;

  // html is a jQuery object on V13 and may be a bare element elsewhere; never
  // reference the jQuery global directly, it is not guaranteed to be defined.
  const root = typeof html?.querySelector === "function" ? html : html?.[0];
  const select = root?.querySelector("#evolve-select");
  if (!select) return;

  for (const option of select.options) {
    const entry = entries.find((e) => e.slug === option.value);
    if (!entry?.ptreBlocked) continue;
    option.disabled = true;
    if (!option.dataset.ptreAnnotated) {
      option.dataset.ptreAnnotated = "1";
      option.text = `${option.text} — ${entry.ptreReasons.join("; ")}`;
    }
  }
}

Hooks.on("renderLevelUpForm", async (app, html) => {
  if (!patched && app?.data) {
    patched = patchLevelUpData(Object.getPrototypeOf(app.data));
    if (patched) {
      // This form was built before the patch existed, so rebuild it once.
      app.data.evolutions = null;
      await app.data.refresh();
      return void app.render(false);
    }
  }
  annotateBlockedOptions(app, html);
});
