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

const bracketDelta = (text) =>
  (text.match(/[[{]/g)?.length ?? 0) - (text.match(/[\]}]/g)?.length ?? 0);

/**
 * Reassemble a compound predicate that the species sheet tore apart.
 *
 * `_updateObject` stores the Restriction column as
 * `restrictions.split(",").map(trim)` (species/sheet.js:386), so a compound typed
 * into that field is shredded on save:
 *
 *   ["or", "self:ability:own-tempo", "self:pokemon:shiny"]
 *     -> ['["or"', '"self:ability:own-tempo"', '"self:pokemon:shiny"]']
 *
 * Since separate entries are ANDed, every fragment then fails and the evolution
 * is blocked forever. This walks the list and rejoins anything between an
 * unbalanced opening bracket and its closing partner. An unterminated run is
 * emitted as-is so it still fails closed with a readable message.
 */
function normalizeRestrictions(list) {
  const out = [];
  let buffer = null;
  let depth = 0;

  for (const raw of list ?? []) {
    const text = String(raw ?? "").trim();

    if (buffer === null) {
      const delta = bracketDelta(text);
      if (delta > 0) {
        buffer = text;
        depth = delta;
      } else {
        out.push(text);
      }
      continue;
    }

    buffer += `, ${text}`;
    depth += bracketDelta(text);
    if (depth <= 0) {
      out.push(buffer);
      buffer = null;
      depth = 0;
    }
  }

  if (buffer !== null) out.push(buffer);
  return out;
}

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
      restrictions: normalizeRestrictions(restrictions),
      fromSource: !row.other?.evolutionItem && !!evolutionItem,
    });
  }
  return out;
}

/* ─────────────────────────────── actor inspection ──────────────────────────── */

/**
 * Every comparison key for what this Pokémon is holding.
 *
 * The Pokémon sheet's "Held Items" panel is not a field — it renders the
 * actor's owned items of type `item` (pokemon-sheet-compact.hbs:764-773 passes
 * `items` straight to the item-display partial). So a held item is an owned
 * document, matched on both its slug and its name.
 *
 * `system.heldItem` is also included: it is a free-text field carrying an item
 * NAME, used by the trainer sheet and the token panel. Older data may sit there.
 *
 * @returns {Set<string>}
 */
function ownedIndex(actor) {
  const byType = new Map();
  const any = new Set();

  const add = (type, key) => {
    if (!key) return;
    if (!byType.has(type)) byType.set(type, new Set());
    byType.get(type).add(key);
    any.add(key);
  };

  for (const doc of actor?.items ?? []) {
    // A stack that has been used up is not held any more. Only items stack.
    if (doc.type === "item") {
      const quantity = Number(doc.system?.quantity ?? 1);
      if (Number.isFinite(quantity) && quantity <= 0) continue;
    }
    for (const candidate of [doc.system?.slug, doc.slug, doc.name]) {
      add(doc.type, norm(candidate));
    }
  }

  const legacy = actor?.system?.heldItem;
  if (legacy && legacy !== "None") add("item", norm(legacy));

  return { byType, any, actor };
}

/** How a requirement of each type should read to a player. */
const REQUIREMENT_PHRASING = {
  item: (label) => `needs held ${label}`,
  ability: (label) => `needs the ${label} ability`,
  move: (label) => `must know ${label}`,
  contestmove: (label) => `must know ${label}`,
  pokeedge: (label) => `needs the ${label} Poké Edge`,
  capability: (label) => `needs the ${label} capability`,
  spiritaction: (label) => `needs the ${label} spirit action`,
  condition: (label) => `must be ${label}`,
  effect: (label) => `needs the ${label} effect`,
};

/**
 * Is a condition/effect currently on this actor?
 *
 * An active condition registers itself two ways in `prepareActorData`
 * (item/effect-types/condition/document.js:261-266): `actor.conditions.set(id, doc)`
 * and `actor.rollOptions.conditions[slug] = true`. The roll-option registry is
 * the live answer, so it is checked first; owned documents are the fallback for
 * effects that never register.
 */
function hasCondition(actor, key) {
  if (actor?.rollOptions?.conditions?.[key]) return true;

  for (const [optionSlug, on] of Object.entries(actor?.rollOptions?.conditions ?? {})) {
    if (on && norm(optionSlug) === key) return true;
  }

  for (const condition of actor?.conditions?.values?.() ?? []) {
    if ([condition.slug, condition.name].some((c) => norm(c) === key)) return true;
  }

  return false;
}

/**
 * Does the actor satisfy a dropped requirement?
 *
 * Entries written before the drop target was extended carry no `type`, so those
 * match against everything the actor owns.
 */
function satisfiesDropped(owned, requirement) {
  const key = norm(requirement?.slug ?? requirement?.name);
  if (!key) return { ok: true };

  const type = requirement.type;
  const satisfied = type ? owned.byType.get(type)?.has(key) ?? false : owned.any.has(key);
  if (satisfied) return { ok: true };

  // A condition may be live on the actor without being matched above.
  if ((!type || type === "condition" || type === "effect") && hasCondition(owned.actor, key)) {
    return { ok: true };
  }

  const label = requirement.name ?? prettify(requirement.slug);
  const phrase = REQUIREMENT_PHRASING[type] ?? ((l) => `requires ${l}`);
  return { ok: false, reason: phrase(label) };
}

/* ─────────────────────── computed restriction keywords ─────────────────────── */

/** PTR's real element types. Some compendium moves carry a *contest* type
 *  ("tough", "beauty", "smart", "cool", "cute") in `system.type`; those are not
 *  element types and must not be matched. */
const ELEMENT_TYPES = new Set([
  "normal", "fire", "water", "electric", "grass", "ice", "fighting", "poison",
  "ground", "flying", "psychic", "bug", "rock", "ghost", "dragon", "dark",
  "steel", "fairy", "shadow", "nuclear",
]);

const STAT_ALIASES = {
  hp: "hp", health: "hp",
  atk: "atk", attack: "atk",
  def: "def", defense: "def", defence: "def",
  spatk: "spatk", specialattack: "spatk", spattack: "spatk", spa: "spatk",
  spdef: "spdef", specialdefense: "spdef", specialdefence: "spdef",
  spd: "spd", speed: "spd",
};

const COMPARATORS = {
  ">": (a, b) => a > b,
  "<": (a, b) => a < b,
  ">=": (a, b) => a >= b,
  "<=": (a, b) => a <= b,
  "=": (a, b) => a === b,
  "==": (a, b) => a === b,
  "!=": (a, b) => a !== b,
};

/**
 * Read one stat. `source` picks which number:
 *   total   — species base plus modifiers (the stat as played)
 *   levelup — the points the player actually invested (the Tyrogue question)
 *   value   — base plus base-stat modifiers, before level-up points
 */
function statValue(actor, stat, source = "total") {
  const block = actor?.system?.stats?.[stat];
  if (!block) return null;
  const raw = source === "levelup" ? block.levelUp : block[source];
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Computed restrictions that roll options cannot express.
 *
 *   movetype:fairy           knows any move of that element type
 *   move:aqua-tail           knows that specific move
 *   stat:atk>def             compare stats as played
 *   stat:levelup:atk>def     compare the points the player invested
 *   loyalty>=4               numeric compare on system.loyalty / friendship
 *
 * @returns {{ok: boolean, reason?: string}|null} null = not one of these
 */
function checkComputed(text, actor, owned) {
  const moveType = /^move-?type\s*:\s*(.+)$/i.exec(text);
  if (moveType) {
    const wanted = norm(moveType[1]);
    if (!ELEMENT_TYPES.has(wanted)) {
      return { ok: false, reason: `unknown move type "${moveType[1].trim()}"` };
    }
    const known = (actor?.itemTypes?.move ?? []).some(
      (m) => norm(m.system?.type) === wanted
    );
    return known
      ? { ok: true }
      : { ok: false, reason: `must know a ${prettify(wanted)} move` };
  }

  const condition = /^(?:condition|effect|status)\s*:\s*(.+)$/i.exec(text);
  if (condition) {
    const wanted = norm(condition[1]);
    const present =
      hasCondition(actor, wanted) ||
      owned.byType.get("condition")?.has(wanted) ||
      owned.byType.get("effect")?.has(wanted);
    return present
      ? { ok: true }
      : { ok: false, reason: `must be ${prettify(condition[1])}` };
  }

  const move = /^move\s*:\s*(.+)$/i.exec(text);
  if (move) {
    const wanted = norm(move[1]);
    return owned.byType.get("move")?.has(wanted)
      ? { ok: true }
      : { ok: false, reason: `must know ${prettify(move[1])}` };
  }

  const stat = /^stat\s*:\s*(?:(total|levelup|value)\s*:\s*)?([a-z]+)\s*(>=|<=|!=|==|=|>|<)\s*([a-z]+|\d+)\s*$/i
    .exec(text);
  if (stat) {
    const [, source = "total", leftName, op, rightRaw] = stat;
    const left = STAT_ALIASES[norm(leftName)];
    if (!left) return { ok: false, reason: `unknown stat "${leftName}"` };

    const leftValue = statValue(actor, left, norm(source) || "total");
    const isNumber = /^\d+$/.test(rightRaw);
    const right = isNumber ? null : STAT_ALIASES[norm(rightRaw)];
    if (!isNumber && !right) return { ok: false, reason: `unknown stat "${rightRaw}"` };

    const rightValue = isNumber
      ? Number(rightRaw)
      : statValue(actor, right, norm(source) || "total");

    if (leftValue === null || rightValue === null) {
      return { ok: false, reason: `stats unavailable for "${text}"` };
    }

    const passed = COMPARATORS[op](leftValue, rightValue);
    const rightLabel = isNumber ? rightRaw : prettify(right);
    const qualifier = norm(source) === "levelup" ? "invested " : "";
    return passed
      ? { ok: true }
      : { ok: false, reason: `needs ${qualifier}${prettify(left)} ${op} ${rightLabel}` };
  }

  const numeric = /^(loyalty|friendship|level)\s*(>=|<=|!=|==|=|>|<)\s*(\d+)\s*$/i.exec(text);
  if (numeric) {
    const [, field, op, target] = numeric;
    const key = norm(field);
    const actual = Number(
      key === "level" ? actor?.system?.level?.current : actor?.system?.[key]
    );
    if (!Number.isFinite(actual)) {
      return { ok: false, reason: `${key} unavailable` };
    }
    return COMPARATORS[op](actual, Number(target))
      ? { ok: true }
      : { ok: false, reason: `needs ${key} ${op} ${target}` };
  }

  return null;
}

/* ─────────────────────────── roll-option predicates ────────────────────────── */

/**
 * PTR's own predicate class, imported at setup. Without it a single statement
 * still works as a plain roll-option lookup; only and/or/not and numeric
 * comparisons need the real engine.
 */
let PTUPredicate = null;

/**
 * Does this restriction read as a roll-option statement rather than an item name?
 *
 * JSON is accepted so the Restriction column can hold a full predicate, e.g.
 *   ["or", "self:ability:own-tempo", "self:types:rock"]
 * A bare statement is recognised by its colon, which no item name contains.
 *
 * @returns {Array|null} predicate statements, or null if this is not a predicate
 */
const PREDICATE_OPERATORS = new Set([
  "and", "or", "not", "nand", "nor", "xor", "if", "iff",
  "eq", "ne", "gt", "gte", "lt", "lte",
]);

function parsePredicate(text) {
  if (text.startsWith("[") || text.startsWith("{")) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return "malformed";
    }
    if (!Array.isArray(parsed)) return [parsed];
    // ["or", a, b] is ONE compound statement; ["self:a", "self:b"] is two.
    return PREDICATE_OPERATORS.has(parsed[0]) ? [parsed] : parsed;
  }
  return text.includes(":") ? [text] : null;
}

/** Turn a statement into something a player can act on. */
function describePredicate(text) {
  const ability = /^self:ability:(.+)$/i.exec(text);
  if (ability) return `needs the ${prettify(ability[1])} ability`;

  const type = /^self:types:(.+)$/i.exec(text);
  if (type) return `must be ${prettify(type[1])} type`;

  if (/^self:pokemon:shiny$/i.test(text)) return "must be shiny";

  const edge = /^pokeedge:(.+)$/i.exec(text);
  if (edge) return `needs the ${prettify(edge[1])} Poké Edge`;

  return `requires ${text}`;
}

function testPredicate(statements, actor, text) {
  // Conditions live in their own roll-option domain, which getRollOptions()
  // does not include by default (actor/base.js:430-443).
  const options = actor?.getRollOptions?.(["conditions"]) ?? [];

  const passed = PTUPredicate
    ? new PTUPredicate(statements).test(options)
    : statements.every((s) => typeof s === "string" && options.includes(s));

  if (passed) return { ok: true };
  return { ok: false, reason: describePredicate(typeof statements[0] === "string" ? statements[0] : text) };
}

/* ──────────────────────────── requirement evaluation ───────────────────────── */

function checkRestriction(raw, actor, { speciesSlug, evolutionSlug, gmAllowed, owned }) {
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

  // Explicit held-item requirement, equivalent to dropping the item on the row.
  const explicitItem = /^item:(.+)$/i.exec(text);
  if (explicitItem) {
    const wanted = norm(explicitItem[1]);
    return owned.byType.get("item")?.has(wanted)
      ? { ok: true }
      : { ok: false, reason: `needs held ${prettify(explicitItem[1])}` };
  }

  // Computed conditions that roll options cannot express: move type, stat
  // comparisons, loyalty thresholds. Checked before the predicate branch because
  // several of these also contain a colon.
  const computed = checkComputed(text, actor, owned);
  if (computed) return computed;

  // A roll-option statement, handed to the system's own predicate engine. This
  // covers everything PTR already publishes about an actor — `self:types:fairy`,
  // `self:ability:own-tempo`, `self:pokemon:shiny`, `self:atk:stage:2`,
  // `pokeedge:<slug>` — plus anything a rule element injects.
  const statements = parsePredicate(text);
  if (statements === "malformed") {
    warnOnce(
      `${speciesSlug}/${evolutionSlug}/badjson`,
      `restriction on ${speciesSlug} -> ${evolutionSlug} looks like a predicate but is not ` +
        `valid JSON: ${text}`
    );
    return { ok: false, reason: "malformed requirement — see console" };
  }
  if (statements) return testPredicate(statements, actor, text);

  // Anything else is treated as an item the Pokémon must hold, so the
  // compendium's bare tags ("Thunderstone", "Ice Stone", "Sweet") work as
  // written. Genuine typos fail closed and are logged once.
  warnOnce(
    `${speciesSlug}/${evolutionSlug}/${key}`,
    `restriction "${text}" on ${speciesSlug} -> ${evolutionSlug} is not a known keyword; ` +
      `treating it as a held-item requirement. Drop the item on the species sheet's Item ` +
      `column instead to make this explicit.`
  );

  return owned.byType.get("item")?.has(key)
    ? { ok: true }
    : { ok: false, reason: `needs held ${prettify(text)}` };
}

/**
 * @returns {{ok: boolean, reasons: string[]}}
 */
function evaluate(requirement, actor, speciesSlug, evolutionSlug, gmAllowed, owned) {
  const reasons = [];

  const dropped = requirement?.evolutionItem;
  if (dropped) {
    const result = satisfiesDropped(owned, dropped);
    if (!result.ok) reasons.push(result.reason);
  }

  for (const entry of requirement?.restrictions ?? []) {
    const result = checkRestriction(entry, actor, { speciesSlug, evolutionSlug, gmAllowed, owned });
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
  const owned = ownedIndex(actor);
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

    const { ok, reasons } = evaluate(requirement, actor, speciesSlug, entry.slug, isGM, owned);
    entry.ptreBlocked = !ok;
    entry.ptreReasons = reasons;
    // Whether the Pokémon itself meets the conditions, ignoring GM privilege,
    // so a GM is not auto-evolved into a "GM permission" form.
    entry.ptreEarned = isGM
      ? evaluate(requirement, actor, speciesSlug, entry.slug, false, owned).ok
      : ok;
  }

  if (CONFIG.debug?.ptreEvolution) {
    console.debug(
      `${MODULE_ID} | ${actor.name} (${speciesSlug}) owns: ${[...owned.any].join(", ") || "(nothing)"}`,
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

/* ────────────────────────────── consuming the item ─────────────────────────── */

/** The owned item backing a requirement, or null. Prefers the smallest live stack. */
function findHeldItem(actor, requiredKey) {
  const matches = (actor?.itemTypes?.item ?? []).filter((item) => {
    const quantity = Number(item.system?.quantity ?? 1);
    if (Number.isFinite(quantity) && quantity <= 0) return false;
    return [item.system?.slug, item.slug, item.name].some((c) => norm(c) === requiredKey);
  });

  if (!matches.length) return null;
  return matches.sort(
    (a, b) => Number(a.system?.quantity ?? 1) - Number(b.system?.quantity ?? 1)
  )[0];
}

/**
 * Spend the item that unlocked the chosen evolution: decrement by one, and
 * delete the item when the stack reaches zero. Mirrors this module's own
 * ConsumeItem rule element.
 *
 * Only the item **dropped on the species sheet's Item column** is consumed. A
 * requirement inferred from free restriction text is a legacy fallback and is
 * deliberately left alone — spending an item on a fuzzy string match is not
 * something to do behind the GM's back.
 */
async function consumeEvolutionItem(data, result) {
  const chosen = result?.evolution;
  const actor = data?.pokemon;
  const speciesSlug = actor?.species?.slug;
  if (!chosen?.slug || !speciesSlug || chosen.slug === speciesSlug) return;

  // finalize() is only reached through the Submit button, but guard anyway.
  if (data.ptreItemConsumed) return;
  data.ptreItemConsumed = true;

  const requirements = await requirementRows(actor.species);
  const dropped = requirements.get(chosen.slug)?.evolutionItem;
  const requiredKey = norm(dropped?.slug ?? dropped?.name);
  if (!requiredKey) return;

  // Only a real item is a cost. An ability, move or Poké Edge is a condition and
  // must never be decremented. Entries with no recorded type predate the extended
  // drop target; findHeldItem only searches itemTypes.item, so they stay safe.
  if (dropped.type && dropped.type !== "item") return;

  const target = findHeldItem(actor, requiredKey);
  if (!target?.id) {
    console.warn(
      `${MODULE_ID} | ${actor.name} evolved into ${chosen.slug} but the required ` +
        `"${prettify(dropped.slug ?? dropped.name)}" was not found to consume.`
    );
    return;
  }

  const current = Number(target.system?.quantity ?? 1);
  const next = current - 1;

  if (next > 0) {
    await actor.updateEmbeddedDocuments("Item", [{ _id: target.id, "system.quantity": next }]);
  } else {
    await actor.deleteEmbeddedDocuments("Item", [target.id]);
  }

  console.log(
    `${MODULE_ID} | ${actor.name} -> ${chosen.slug}: consumed ${target.name} ` +
      `(${current} -> ${next > 0 ? next : "removed"}).`
  );
}

/* ──────────────────────────────── the patch ────────────────────────────────── */

function patchLevelUpData(proto) {
  if (!proto || proto.ptreEvolutionRequirementsPatched) return false;

  const original = proto.refresh;
  if (typeof original !== "function") {
    console.error(`${MODULE_ID} | LevelUpData#refresh not found; evolution gating NOT installed.`);
    return false;
  }

  const originalFinalize = proto.finalize;
  if (typeof originalFinalize === "function") {
    // finalize() is the confirm moment: LevelUpForm's Submit button closes with
    // {properClose: true}, which is the only path that calls it (sheet.js:83,185).
    proto.finalize = async function (...args) {
      const result = await originalFinalize.apply(this, args);
      try {
        await consumeEvolutionItem(this, result);
      } catch (error) {
        console.error(`${MODULE_ID} | failed to consume the evolution item`, error);
      }
      return result;
    };
  } else {
    console.warn(`${MODULE_ID} | LevelUpData#finalize not found; items will NOT be consumed.`);
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

  // Optional: without it, single roll-option statements still work as a plain
  // lookup — only and/or/not and numeric comparisons need the real engine.
  try {
    ({ PTUPredicate } = await import("/systems/ptu/src/module/system/predication.js"));
  } catch (error) {
    console.warn(
      `${MODULE_ID} | PTUPredicate unavailable; compound predicates in evolution ` +
        `restrictions will not work.`,
      error
    );
  }

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
