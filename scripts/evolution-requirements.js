/**
 * Evolution Requirements — gate level-up evolution options on real conditions
 * ---------------------------------------------------------------------------
 * PTR builds the level-up evolution list in LevelUpData#refresh()
 * (src/module/apps/level-up-form/document.js). It calls
 * PokemonGenerator.isEvolutionRestricted() as a gate, but that gate is inert:
 *
 *   1. It reacts to exactly "male" / "female" and returns undefined (= allowed)
 *      for every other restriction string, so "GM Permission", "Thunderstone",
 *      "Ice Stone" and "Fire Stone" — all real data in the shipped compendium —
 *      have never done anything.
 *   2. The level-up form calls it as `isEvolutionRestricted(evo, this.pokemon.gender)`
 *      but the signature is `(stage, { gender } = {})`. A bare value is passed
 *      where a destructured object is expected, AND PTUPokemon has no `.gender`
 *      getter (everything else reads `system.gender`), so gender was undefined
 *      twice over. Gender restrictions work in NPC generation and have never
 *      worked on the level-up screen.
 *
 * Result: an Eevee at level 25 offers all 19 of its level-25 evolutions and the
 * form picks one AT RANDOM as the default selection.
 *
 * This module filters that list instead. Scope is the level-up screen only —
 * random NPC generation is left alone.
 *
 * Presentation:
 *   - Players see only evolutions the Pokémon qualifies for.
 *   - A GM sees every evolution; unmet ones are disabled in the dropdown with
 *     the reason appended to the label.
 *
 * Default selection: if exactly one evolution qualifies it is preselected; if
 * several do, the form defaults to "stay as you are" so the choice is made
 * deliberately rather than rolled. This is what replaces the random pick.
 *
 * Patch strategy: LevelUpData is not exported to game.ptu, so its prototype is
 * captured from the first rendered form via the renderLevelUpForm hook. No
 * system files are edited.
 */

import { EVOLUTION_REQUIREMENTS, ITEM_ALIASES } from "./evolution-requirements-data.js";

const MODULE_ID = "PTRe1-Adjustment-Modules";

const slugify = (s) =>
  String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Unknown tags are warned about once each, not once per render. */
const warnedTags = new Set();

/* ────────────────────────────── restriction parsing ────────────────────────── */

/**
 * @returns {{kind: string, value?: string, raw: string}|null} null = no requirement
 */
function parseRestriction(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null; // "" is the system's own "no requirement"

  const slug = slugify(text);
  if (!slug) return null;

  if (slug === "male" || slug === "female") return { kind: "gender", value: slug, raw: text };
  if (slug === "gm" || slug === "gm-permission") return { kind: "gm", raw: text };

  const explicitItem = /^item:(.+)$/i.exec(text);
  if (explicitItem) return { kind: "item", value: slugify(explicitItem[1]), raw: text };

  const alias = ITEM_ALIASES[slug];
  if (alias) return { kind: "item", value: alias, raw: text };

  return { kind: "unknown", value: slug, raw: text };
}

/** The held item's slug, or null when nothing is held. */
function heldItemSlug(actor) {
  const held = actor?.system?.heldItem;
  if (!held || held === "None") return null;
  return slugify(held) || null;
}

/**
 * @returns {{ok: boolean, reason?: string}}
 */
function checkRestriction(restriction, actor, { speciesSlug, evolutionSlug } = {}) {
  switch (restriction.kind) {
    case "gender": {
      const actual = slugify(actor?.system?.gender);
      if (!actual) return { ok: false, reason: `must be ${restriction.value}` };
      return actual === restriction.value
        ? { ok: true }
        : { ok: false, reason: `must be ${restriction.value}` };
    }

    case "item": {
      const held = heldItemSlug(actor);
      const label = restriction.value.replace(/-/g, " ");
      return held === restriction.value
        ? { ok: true }
        : { ok: false, reason: `needs held ${label}` };
    }

    case "gm":
      return game.user?.isGM ? { ok: true } : { ok: false, reason: "GM permission" };

    case "unknown": {
      const key = `${speciesSlug}/${evolutionSlug}/${restriction.value}`;
      if (!warnedTags.has(key)) {
        warnedTags.add(key);
        console.warn(
          `${MODULE_ID} | unrecognised evolution requirement "${restriction.raw}" on ` +
            `${speciesSlug} -> ${evolutionSlug}; blocking it. Add an alias or an ` +
            `override in scripts/evolution-requirements-data.js.`
        );
      }
      return { ok: false, reason: `unrecognised requirement "${restriction.raw}"` };
    }

    default:
      return { ok: true };
  }
}

/** Restrictions for one evolution: an override wins over the species item's own data. */
function restrictionsFor(speciesSlug, evolutionSlug, speciesEvolutions) {
  const override = EVOLUTION_REQUIREMENTS[speciesSlug]?.[evolutionSlug];
  if (override) return override;
  const row = speciesEvolutions?.find((e) => e.slug === evolutionSlug);
  return row?.other?.restrictions ?? [];
}

/**
 * @returns {{ok: boolean, reasons: string[]}}
 */
function evaluateEvolution(speciesSlug, evolutionSlug, speciesEvolutions, actor) {
  const raw = restrictionsFor(speciesSlug, evolutionSlug, speciesEvolutions);
  const reasons = [];

  for (const entry of raw) {
    const parsed = parseRestriction(entry);
    if (!parsed) continue;
    const result = checkRestriction(parsed, actor, { speciesSlug, evolutionSlug });
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

  const speciesEvolutions = actor.species.system?.evolutions ?? [];
  const isGM = !!game.user?.isGM;

  for (const entry of evolutions.available) {
    // "Stay as you are" is never gated.
    if (entry.slug === speciesSlug) {
      entry.ptreBlocked = false;
      entry.ptreReasons = [];
      continue;
    }
    const { ok, reasons } = evaluateEvolution(speciesSlug, entry.slug, speciesEvolutions, actor);
    entry.ptreBlocked = !ok;
    entry.ptreReasons = reasons;
  }

  // Players get the filtered list. A GM keeps the full list and sees the
  // blocked entries disabled in the dropdown instead.
  if (!isGM) {
    const permitted = evolutions.available.filter((e) => !e.ptreBlocked);
    evolutions.available = permitted.length ? permitted : evolutions.available.filter((e) => e.slug === speciesSlug);
  }

  const permitted = evolutions.available.filter((e) => !e.ptreBlocked);
  const realEvolutions = permitted.filter((e) => e.slug !== speciesSlug);
  const selfEntry =
    evolutions.available.find((e) => e.slug === speciesSlug) ?? {
      uuid: actor.species.uuid,
      slug: speciesSlug,
      level: data.level?.current,
    };

  // Exactly one qualifying evolution preselects it; several means the player
  // chooses, so default to staying put rather than rolling one at random.
  const target = realEvolutions.length === 1 ? realEvolutions[0] : selfEntry;

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
