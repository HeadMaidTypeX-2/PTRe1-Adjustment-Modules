/**
 * Evolution Requirements — gate level-up evolution options on the species item
 * ----------------------------------------------------------------------------
 * PTR's species sheet already describes conditional evolutions and nothing
 * enforces it:
 *
 *   - An **Item** drop target per evolution row, stored as
 *     `evolution.other.evolutionItem = { slug, uuid }` (species/sheet.js:319).
 *     No system code reads it back — `convertToPTUSpecies` writes it as
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
 *      (`system.gender` is the real path).
 *
 * Result: an Eevee at level 25 offered all 19 of its level-25 evolutions and
 * preselected one AT RANDOM.
 *
 * ── Two traps this module has to work around ────────────────────────────────
 *
 * 1. `actor.species` is `itemTypes.species[0]` — the species item EMBEDDED on
 *    the actor (pokemon/document.js:16-22). It is a snapshot taken when the
 *    Pokémon was made, and nothing in the system ever syncs it from the world
 *    or compendium item. Editing the species item a GM has open therefore does
 *    NOT reach Pokémon that already exist. This module falls back to the source
 *    item for any row the embedded copy does not describe, so dropping an item
 *    on the species sheet works on existing Pokémon too.
 *
 * 2. `LevelUpForm#render` (sheet.js:156-166) is fire-and-forget: it kicks off
 *    `this.data.refresh().then(() => this._render(...))` and returns `this`
 *    immediately. Anything that patches from inside the render hook and then
 *    calls `render()` again is racing that promise chain — which showed up as
 *    the window appearing ungated, then correcting itself, and sometimes not
 *    correcting at all. So the prototype is patched at `setup`, before any form
 *    can be constructed, by importing LevelUpData from the live system.
 *
 * Presentation:
 *   - Players see only evolutions the Pokémon qualifies for.
 *   - A GM sees every evolution; unmet ones are disabled in the dropdown with
 *     the reason appended to the label.
 *
 * Default selection: exactly one *earned* evolution is preselected; several
 * means the form defaults to "stay as you are". GM permission does not count as
 * earned, so a GM is never auto-evolved into a GM-gated form.
 *
 * Scope is the level-up screen only — random NPC generation is left alone.
 * No system files are edited.
 */

const MODULE_ID = "PTRe1-Adjustment-Modules";

/**
 * Comparison key: lowercase, alphanumerics only. Collapses the difference
 * between an item's slug and the free-text held-item name:
 *   "Water Stone" / "water-stone"    -> "waterstone"
 *   "King's Rock" / "kings-rock"     -> "kingsrock"
 *   "Thunderstone" / "Thunder Stone" -> "thunderstone"
 */
const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/** "water-stone" -> "Water Stone", for player-facing reasons. */
const prettify = (slug) =>
  String(slug ?? "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

const warned = new Set();
const warnOnce = (key, message) => {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`${MODULE_ID} | ${message}`);
};

/* ──────────────────────── species rows (embedded + source) ─────────────────── */

/** uuid -> evolution rows of the source species item, or null when unresolvable. */
const sourceRowCache = new Map();

const hasRestrictions = (list) =>
  Array.isArray(list) && list.some((r) => String(r ?? "").trim() !== "");

/** The uuid this embedded species item was copied from, if any. */
function sourceUuidOf(species) {
  return species?._stats?.compendiumSource ?? species?.flags?.core?.sourceId ?? null;
}

async function sourceRowsOf(species) {
  const uuid = sourceUuidOf(species);
  if (!uuid) return null;
  if (sourceRowCache.has(uuid)) return sourceRowCache.get(uuid);

  let rows = null;
  try {
    const source = await fromUuid(uuid);
    rows = source?.system?.evolutions ?? null;
  } catch (error) {
    console.warn(`${MODULE_ID} | could not resolve source species ${uuid}`, error);
  }
  sourceRowCache.set(uuid, rows);
  return rows;
}

/**
 * Requirements per evolution slug, taking the embedded row as authoritative and
 * filling gaps from the source species item. This is what makes an edit to the
 * species item reach Pokémon that already exist.
 *
 * @returns {Map<string, {evolutionItem: object|null, restrictions: string[], fromSource: boolean}>}
 */
async function requirementRows(species) {
  const own = species?.system?.evolutions ?? [];
  const source = await sourceRowsOf(species);
  const sourceBySlug = new Map((source ?? []).map((r) => [r.slug, r]));

  const out = new Map();
  for (const row of own) {
    const fallback = sourceBySlug.get(row.slug);
    const evolutionItem = row.other?.evolutionItem ?? fallback?.other?.evolutionItem ?? null;
    const restrictions = hasRestrictions(row.other?.restrictions)
      ? row.other.restrictions
      : fallback?.other?.restrictions ?? row.other?.restrictions ?? [];

    out.set(row.slug, {
      evolutionItem,
      restrictions,
      fromSource: !row.other?.evolutionItem && !!evolutionItem,
    });
  }
  return out;
}

/* ─────────────────────────────── actor inspection ──────────────────────────── */

/**
 * The held item's comparison key, or null when nothing is held.
 * `system.heldItem` is free text holding an item NAME ("None" = empty).
 */
function heldItemKey(actor) {
  const held = actor?.system?.heldItem;
  if (!held || held === "None") return null;
  return norm(held) || null;
}

/* ──────────────────────────── requirement evaluation ───────────────────────── */

function checkRestriction(raw, actor, { speciesSlug, evolutionSlug, gmAllowed }) {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: true };

  const key = norm(text);
  if (!key) return { ok: true };

  if (key === "male" || key === "female") {
    const actual = norm(actor?.system?.gender);
    return actual === key ? { ok: true } : { ok: false, reason: `must be ${key}` };
  }

  if (key === "gm" || key === "gmpermission") {
    return gmAllowed ? { ok: true } : { ok: false, reason: "GM permission" };
  }

  // Anything else is treated as an item the Pokémon must hold, so the
  // compendium's bare tags ("Thunderstone", "Ice Stone", "Sweet") work as
  // written. Genuine typos fail closed and are logged once.
  warnOnce(
    `${speciesSlug}/${evolutionSlug}/${key}`,
    `restriction "${text}" on ${speciesSlug} -> ${evolutionSlug} is not a known keyword; ` +
      `treating it as a held-item requirement. Drop the item on the species sheet's Item ` +
      `column instead to make this explicit.`
  );

  return heldItemKey(actor) === key
    ? { ok: true }
    : { ok: false, reason: `needs held ${prettify(text)}` };
}

/**
 * @returns {{ok: boolean, reasons: string[]}}
 */
function evaluate(requirement, actor, speciesSlug, evolutionSlug, gmAllowed) {
  const reasons = [];

  const dropped = requirement?.evolutionItem;
  const requiredKey = norm(dropped?.slug ?? dropped?.name);
  if (requiredKey && heldItemKey(actor) !== requiredKey) {
    reasons.push(`needs held ${prettify(dropped.slug ?? dropped.name)}`);
  }

  for (const entry of requirement?.restrictions ?? []) {
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
 * @returns {Promise<boolean>} true when `current` changed and stats need recomputing
 */
async function applyRequirements(data) {
  const actor = data.pokemon;
  const species = actor?.species;
  const speciesSlug = species?.slug;
  const evolutions = data.evolutions;
  if (!speciesSlug || !evolutions?.available?.length) return false;

  const requirements = await requirementRows(species);
  const isGM = !!game.user?.isGM;

  for (const entry of evolutions.available) {
    // "Stay as you are" is never gated.
    if (entry.slug === speciesSlug) {
      entry.ptreBlocked = false;
      entry.ptreEarned = false;
      entry.ptreReasons = [];
      continue;
    }

    const requirement = requirements.get(entry.slug);
    if (!requirement) {
      // The available list named an evolution the species item does not
      // describe. Leave it alone rather than blocking something unknown.
      warnOnce(
        `${speciesSlug}/${entry.slug}/missing-row`,
        `${speciesSlug} offers "${entry.slug}" but its species item has no matching ` +
          `evolution row; leaving it unrestricted.`
      );
      entry.ptreBlocked = false;
      entry.ptreEarned = true;
      entry.ptreReasons = [];
      continue;
    }

    const { ok, reasons } = evaluate(requirement, actor, speciesSlug, entry.slug, isGM);
    entry.ptreBlocked = !ok;
    entry.ptreReasons = reasons;
    // Whether the Pokémon itself meets the conditions, ignoring GM privilege,
    // so a GM is not auto-evolved into a "GM permission" form.
    entry.ptreEarned = isGM
      ? evaluate(requirement, actor, speciesSlug, entry.slug, false).ok
      : ok;
  }

  if (CONFIG.debug?.ptreEvolution) {
    console.debug(
      `${MODULE_ID} | ${actor.name} (${speciesSlug}) held="${actor.system?.heldItem}"`,
      evolutions.available.map((e) => ({
        evolution: e.slug,
        blocked: e.ptreBlocked,
        reasons: e.ptreReasons?.join("; ") ?? "",
        source: requirements.get(e.slug)?.fromSource ? "source species" : "embedded",
      }))
    );
  }

  // Players get the filtered list. A GM keeps the full list and sees blocked
  // entries disabled in the dropdown instead.
  if (!isGM) {
    const permitted = evolutions.available.filter((e) => !e.ptreBlocked);
    evolutions.available = permitted.length
      ? permitted
      : evolutions.available.filter((e) => e.slug === speciesSlug);
  }

  const earned = evolutions.available.filter((e) => e.ptreEarned && e.slug !== speciesSlug);
  const selfEntry =
    evolutions.available.find((e) => e.slug === speciesSlug) ?? {
      uuid: species.uuid,
      slug: speciesSlug,
      level: data.level?.current,
    };

  const target = earned.length === 1 ? earned[0] : selfEntry;

  if (evolutions.current?.slug !== target.slug) {
    evolutions.current = target;
    return true;
  }
  return false;
}

/* ──────────────────────────────── the patch ────────────────────────────────── */

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
        if (await applyRequirements(this)) result = await original.apply(this, args);
      } catch (error) {
        console.error(`${MODULE_ID} | evolution requirement filtering failed`, error);
      }
    }

    return result;
  };

  proto.ptreEvolutionRequirementsPatched = true;
  return true;
}

/**
 * Patch before any LevelUpForm can exist. LevelUpData is not on game.ptu, but
 * the system's module is importable directly — the same technique this module
 * already uses for the ConsumeItem rule element.
 */
Hooks.once("setup", async () => {
  if (game.system.id !== "ptu") return;

  try {
    const { LevelUpData } = await import(
      "/systems/ptu/src/module/apps/level-up-form/document.js"
    );
    if (patchLevelUpData(LevelUpData?.prototype)) {
      console.log(`${MODULE_ID} | evolution requirements installed (LevelUpData#refresh).`);
    }
  } catch (error) {
    console.error(
      `${MODULE_ID} | could not import LevelUpData; evolution gating NOT installed.`,
      error
    );
  }
});

/** GM view: show every evolution, disable the ones the Pokémon does not qualify for. */
Hooks.on("renderLevelUpForm", (app, html) => {
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
});
