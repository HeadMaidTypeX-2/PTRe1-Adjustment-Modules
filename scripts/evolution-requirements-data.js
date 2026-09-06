/**
 * Evolution Requirements — data tables
 * -------------------------------------
 * Two tables, both keyed by slug. No UUIDs (see the module design principle:
 * no hardcoded UUID constants), so nothing here breaks when a compendium is
 * rebuilt.
 *
 * Restriction grammar — a restriction is a plain string, matched case- and
 * punctuation-insensitively:
 *
 *   ""              no requirement (the system's own default; 1288 rows use it)
 *   "male"          actor's system.gender must match
 *   "female"
 *   "item:<slug>"   actor's system.heldItem must resolve to that item
 *   "gm"            GM permission — visible to a GM, blocked for players
 *   <known alias>   a bare item name listed in ITEM_ALIASES below
 *   <anything else> BLOCKED, with a console warning naming the species and tag
 *
 * Unknown tags fail closed on purpose: a typo shows up as an option the player
 * cannot take plus a warning, instead of an option that silently stays open.
 */

/**
 * Bare restriction strings that already appear in the PTR compendium, mapped to
 * the item slug they mean. Verified against packs/_source at tag 4.4.3.37 —
 * these strings are real data the system ships and has never evaluated.
 *
 * "Tart", "Syrupy" and "Cracked" are deliberately absent: no matching item
 * exists in the compendium, so they are handled in EVOLUTION_REQUIREMENTS
 * below rather than pointing at an item that cannot be held.
 */
export const ITEM_ALIASES = {
  "thunderstone": "thunder-stone",   // Tadbulb -> Bellibolt
  "thunder-stone": "thunder-stone",
  "fire-stone": "fire-stone",        // Capsakid -> Scovillain
  "ice-stone": "ice-stone",          // Cetoddle -> Cetitan
  "water-stone": "water-stone",
  "leaf-stone": "leaf-stone",
  "moon-stone": "moon-stone",
  "sun-stone": "sun-stone",
  "dusk-stone": "dusk-stone",
  "dawn-stone": "dawn-stone",
  "shiny-stone": "shiny-stone",
  "oval-stone": "oval-stone",
  "everstone": "everstone",
  "sweet": "sweet-confection",       // Milcery -> Alcremie
  "sweet-confection": "sweet-confection",
};

/**
 * Per-species overrides, keyed <species slug> -> <evolution slug> -> [restrictions].
 * An entry here REPLACES whatever the species item carries for that evolution.
 * Omit a species entirely to use the system's own data unchanged.
 *
 * ── SOURCING WARNING ────────────────────────────────────────────────────────
 * The Eevee block below is a DRAFT and is NOT sourced from PTR. The shipped
 * Eevee species item carries no restrictions at all (every row is [""]), so the
 * system states no requirements to copy. The three stone lines are the
 * uncontroversial mainline ones and the items exist in the compendium; every
 * other line is a "gm" placeholder standing in for a condition (loyalty, time
 * of day, location, held move) that this module cannot yet evaluate.
 *
 * Confirm against 1e.ptr.wiki before treating any of it as a rule, and replace
 * the placeholders as conditions become expressible.
 * ────────────────────────────────────────────────────────────────────────────
 */
export const EVOLUTION_REQUIREMENTS = {
  eevee: {
    // Items exist in the compendium; mainline-standard, still confirm vs wiki.
    vaporeon: ["item:water-stone"],
    jolteon: ["item:thunder-stone"],
    flareon: ["item:fire-stone"],

    // Real conditions are not item-based. Placeholders until expressible.
    espeon: ["gm"],    // loyalty + daytime
    umbreon: ["gm"],   // loyalty + nighttime
    leafeon: ["gm"],   // location / Leaf Stone depending on edition
    glaceon: ["gm"],   // location / Ice Stone depending on edition
    sylveon: ["gm"],   // loyalty + Fairy-type move

    // Fangame eeveelutions — no published requirements known to this module.
    automateon: ["gm"],
    aviateon: ["gm"],
    champeon: ["gm"],
    companeon: ["gm"],
    corroseon: ["gm"],
    draconeon: ["gm"],
    dungeon: ["gm"],
    illuseon: ["gm"],
    obsideon: ["gm"],
    scorpeon: ["gm"],
    maliceon: ["gm"],  // already tagged "GM Permission" in the compendium
  },

  // Restriction strings the compendium uses that have no backing item.
  // Degraded to GM permission so these families stay evolvable; swap to
  // "item:<slug>" once the corresponding items exist.
  applin: {
    flapple: ["gm"],   // compendium says "Tart"   — no Tart Apple item
    appletun: ["gm"],  // compendium says "Sweet"  — Sweet Confection is Milcery's
    dipplin: ["gm"],   // compendium says "Syrupy" — no Syrupy Apple item
  },
  sinistea: {
    polteageist: ["gm"], // compendium says "Cracked" — no Cracked Pot item
  },
};
