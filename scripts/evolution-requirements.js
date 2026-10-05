/**
 * Evolution add-ons — extends PTR's native evolution predicates (ptu 4.4.3.46+)
 * ----------------------------------------------------------------------------
 * 4.4.3.46 replaced the species sheet's Level / Restriction / Item columns with
 * one `predicate` per evolution row. LevelUpData#refresh tests it against
 * `pokemon.getRollOptions(["evolution"])` with `self:level:<new level>` swapped
 * in, and drops every row that fails. Natively that already covers:
 *
 *   self:level:25+          level            item:<slug>        owned item
 *   self:gender:female      gender           ability:<slug>     owned ability
 *   self:spirit:3+          spirit           move:<slug>        known move
 *   party:species:<slug>    party member     condition:<slug>   active condition
 *   self:evolution-forbidden                 ["or", …] / ["not", …] compounds
 *
 * This file only adds what PTR does not do:
 *
 *   1. Extra roll options, written into the actor's `evolution` domain just
 *      before refresh reads it:
 *        self:stat:atk:20            stat totals (so `self:stat:atk:20+` works)
 *        self:stat:atk>def           pairwise comparisons: >, <, =
 *        self:stat:levelup:atk>def   the same on invested level-up points
 *        self:loyalty:N / self:friendship:N
 *        self:movetype:fairy         knows a move of that element type
 *        party:species:<slug>        also from the trainer's Party FOLDER
 *        item:<slug>                 also from the legacy system.heldItem text
 *        user:gm                     only on a GM's client (GM-permission gate)
 *      The predicate engine's own gt/gte comparison is unusable for these: its
 *      operand regex is `(^:]+)` (predication.js:76), which never matches.
 *
 *   2. Source-species fallback. `actor.species` is an embedded snapshot that the
 *      system never re-syncs, so predicates edited on the world/compendium
 *      species would not reach existing Pokémon. For the synchronous row loop
 *      only, each embedded row's predicate is swapped for its source row's.
 *
 *   3. GM view. The system hides failing rows; a GM gets them back, disabled,
 *      with the failing statements appended. Rows whose level is not reached
 *      yet stay hidden.
 *
 *   4. A GM never gets a `user:gm`-gated evolution preselected.
 *
 *   5. Item consumption. Confirming an evolution spends one of each top-level
 *      `item:<slug>` in its predicate (decrement, delete at 0, smallest stack
 *      first). Items inside compound statements are not consumed.
 *
 * Scope is the level-up screen only. No system files are edited.
 */

import { featureEnabled } from "./feature-toggles.js";

const MODULE_ID = "PTRe1-Adjustment-Modules";

let PTUPredicate = null;

/** "King's Rock" / "kings-rock" -> "kingsrock". */
const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/** "King's Rock" -> "kings-rock", matching PTR item slugs. */
const slugify = (s) =>
  String(s ?? "").toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** "water-stone" -> "Water Stone". */
const prettify = (slug) =>
  String(slug ?? "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

/** Element types; some compendium moves carry a contest type in system.type. */
const ELEMENT_TYPES = new Set([
  "normal", "fire", "water", "electric", "grass", "ice", "fighting", "poison",
  "ground", "flying", "psychic", "bug", "rock", "ghost", "dragon", "dark",
  "steel", "fairy", "shadow", "nuclear",
]);

/* ─────────────────────────────── party lookup ──────────────────────────────── */

/**
 * The trainer's party, resolved as PTR's Party screen does
 * (apps/party/sheet.js #loadFolders / #loadParty): a "Party" folder inside the
 * trainer's folder wins; otherwise Pokémon flagged to the trainer and not boxed.
 * A Pokémon with no trainer flag falls back to its own Party folder.
 */
function partyOf(actor) {
  const trainer = actor?.trainer;
  if (!trainer) {
    return actor?.folder?.name === "Party"
      ? actor.folder.contents.filter((a) => a.type === "pokemon")
      : [];
  }

  const root = trainer.folder;
  const folder = root
    ? root.children?.find((node) => node.folder?.name === "Party")?.folder ??
      game.folders.find((f) => f.name === "Party" && f._source.folder === root.id)
    : null;
  if (folder) return folder.contents.filter((a) => a.type === "pokemon");

  return game.actors.filter(
    (a) =>
      a.type === "pokemon" &&
      a.flags?.ptu?.party?.trainer === trainer.id &&
      !a.flags?.ptu?.party?.boxed
  );
}

/* ───────────────────────────── extra roll options ──────────────────────────── */

function extraOptions(actor) {
  const out = new Set();

  const stats = Object.entries(actor?.system?.stats ?? {});
  const read = (block, key) => {
    const n = Number(key === "levelUp" ? block?.levelUp : block?.total);
    return Number.isFinite(n) ? n : null;
  };
  for (const [prefix, key] of [["self:stat:", "total"], ["self:stat:levelup:", "levelUp"]]) {
    for (const [a, blockA] of stats) {
      const va = read(blockA, key);
      if (va === null) continue;
      out.add(`${prefix}${a}:${va}`);
      for (const [b, blockB] of stats) {
        const vb = read(blockB, key);
        if (a === b || vb === null) continue;
        out.add(`${prefix}${a}${va > vb ? ">" : va < vb ? "<" : "="}${b}`);
      }
    }
  }

  for (const field of ["loyalty", "friendship"]) {
    const n = Number(actor?.system?.[field]);
    if (Number.isFinite(n)) out.add(`self:${field}:${n}`);
  }

  for (const move of actor?.itemTypes?.move ?? []) {
    const type = norm(move.system?.type);
    if (ELEMENT_TYPES.has(type)) out.add(`self:movetype:${type}`);
  }

  for (const member of partyOf(actor)) {
    if (member.id === actor.id) continue;
    const slug = member.species?.slug;
    if (slug) out.add(`party:species:${slug}`);
  }

  const held = actor?.system?.heldItem;
  if (held && held !== "None") out.add(`item:${slugify(held)}`);

  if (game.user?.isGM) out.add("user:gm");

  return out;
}

/** The option set refresh() itself builds (level-up-form/document.js:178-181). */
function evolutionOptions(data) {
  return new Set([
    ...data.pokemon.getRollOptions(["evolution"]).filter((o) => !o.startsWith("self:level:")),
    `self:level:${data.level.new}`,
  ]);
}

const passes = (predicate, options) =>
  !!PTUPredicate && (predicate?.length ?? 0) > 0 && PTUPredicate.test(predicate, options);

/* ──────────────────────────── source-species rows ──────────────────────────── */

async function sourcePredicates(species) {
  const uuid = species?._stats?.compendiumSource ?? species?.flags?.core?.sourceId;
  if (!uuid) return new Map();
  try {
    const source = await fromUuid(uuid);
    return new Map(
      (source?.system?.evolutions ?? [])
        .filter((row) => Array.isArray(row.predicate) && row.predicate.length)
        .map((row) => [row.slug, row.predicate])
    );
  } catch (error) {
    console.warn(`${MODULE_ID} | could not resolve source species ${uuid}`, error);
    return new Map();
  }
}

/**
 * Swap each embedded row's predicate for the source row's. Returns a restore
 * function; callers restore immediately after invoking refresh, whose row loop
 * runs before its first await, so nothing else observes the swap.
 */
function swapPredicates(rows, bySlug) {
  const saved = rows.map((row) => row.predicate);
  rows.forEach((row) => {
    const replacement = bySlug.get(row.slug);
    if (replacement) row.predicate = replacement;
  });
  return () => rows.forEach((row, i) => { row.predicate = saved[i]; });
}

/* ──────────────────────────────── GM view ──────────────────────────────────── */

function describe(statement) {
  if (typeof statement !== "string") return JSON.stringify(statement);
  const rules = [
    [/^self:level:(\d+)\+$/, (m) => `level ${m[1]}+`],
    [/^self:gender:(.+)$/, (m) => `must be ${m[1]}`],
    [/^item:(.+)$/, (m) => `needs held ${prettify(m[1])}`],
    [/^ability:(.+)$/, (m) => `needs the ${prettify(m[1])} ability`],
    [/^move:(.+)$/, (m) => `must know ${prettify(m[1])}`],
    [/^condition:(.+)$/, (m) => `must be ${prettify(m[1])}`],
    [/^party:species:(.+)$/, (m) => `needs ${prettify(m[1])} in the party`],
    [/^self:movetype:(.+)$/, (m) => `must know a ${prettify(m[1])} move`],
    [/^self:stat:levelup:(.+)$/, (m) => `needs invested ${m[1]}`],
    [/^self:stat:(.+)$/, (m) => `needs ${m[1]}`],
    [/^user:gm$/, () => "GM permission"],
  ];
  for (const [pattern, phrase] of rules) {
    const m = pattern.exec(statement);
    if (m) return phrase(m);
  }
  return `requires ${statement}`;
}

/** Re-add rows the system dropped, flagged for the render hook to disable. */
function restoreBlockedRows(data, rows, options) {
  if (options.has("self:evolution-forbidden")) return;

  const speciesSlug = data.pokemon.species.slug;
  const currentIndex = rows.findIndex((row) => row.slug === speciesSlug);
  const offered = new Set(data.evolutions.available.map((e) => e.slug));
  const order = new Map(rows.map((row, i) => [row.slug, i]));

  rows.forEach((row, i) => {
    if (i <= currentIndex || offered.has(row.slug)) return;
    const predicate = row.predicate ?? [];
    const level = predicate.map((p) => /^self:level:(\d+)\+$/.exec(p)?.[1]).find(Boolean);
    if (level && Number(level) > data.level.new) return;

    const reasons = predicate.length
      ? predicate.filter((s) => !PTUPredicate.test([s], options)).map(describe)
      : ["no predicate set"];

    data.evolutions.available.push({
      uuid: row.uuid,
      slug: row.slug,
      level: Number(level ?? 1),
      label: prettify(row.slug),
      ptreBlocked: true,
      ptreReasons: reasons,
    });
  });

  data.evolutions.available.sort((a, b) => (order.get(a.slug) ?? 0) - (order.get(b.slug) ?? 0));
}

/* ─────────────────────────────── consumption ───────────────────────────────── */

async function consumeEvolutionItems(data, result) {
  const actor = data?.pokemon;
  const chosen = result?.evolution?.slug;
  if (!actor || !chosen || chosen === actor.species?.slug || data.ptreItemsConsumed) return;
  data.ptreItemsConsumed = true;

  const predicate = data.ptrePredicates?.get(chosen) ?? [];
  for (const statement of predicate) {
    const slug = typeof statement === "string" ? /^item:(.+)$/.exec(statement)?.[1] : null;
    if (!slug || slug === "equipped") continue;

    const target = actor.itemTypes.item
      .filter((i) => Number(i.system?.quantity ?? 1) > 0)
      .filter((i) => [i.slug, i.system?.slug, i.name].some((c) => norm(c) === norm(slug)))
      .sort((a, b) => Number(a.system?.quantity ?? 1) - Number(b.system?.quantity ?? 1))[0];
    if (!target) {
      console.warn(`${MODULE_ID} | ${actor.name} -> ${chosen}: no "${slug}" left to consume.`);
      continue;
    }

    const next = Number(target.system?.quantity ?? 1) - 1;
    if (next > 0) await actor.updateEmbeddedDocuments("Item", [{ _id: target.id, "system.quantity": next }]);
    else await actor.deleteEmbeddedDocuments("Item", [target.id]);
    console.log(`${MODULE_ID} | ${actor.name} -> ${chosen}: consumed ${target.name}.`);
  }
}

/* ──────────────────────────────── the patch ────────────────────────────────── */

function patchLevelUpData(proto) {
  if (!proto || proto.ptreEvolutionPatched) return false;

  const originalRefresh = proto.refresh;
  const originalFinalize = proto.finalize;

  proto.refresh = async function (...args) {
    if (this.evolutions) return originalRefresh.apply(this, args);

    const actor = this.pokemon;
    const rows = actor.species?.system?.evolutions ?? [];

    // Extra options go into the evolution domain refresh() is about to read.
    // That domain is rebuilt on the next data prep, so nothing persists.
    actor.rollOptions.evolution ??= {};
    for (const option of extraOptions(actor)) actor.rollOptions.evolution[option] = true;

    const bySlug = await sourcePredicates(actor.species);
    this.ptrePredicates = new Map(rows.map((row) => [row.slug, bySlug.get(row.slug) ?? row.predicate ?? []]));

    let pending;
    const restore = swapPredicates(rows, bySlug);
    try {
      pending = originalRefresh.apply(this, args);
    } finally {
      restore();
    }
    let result = await pending;

    try {
      const options = evolutionOptions(this);
      const effective = rows.map((row) => ({ ...row, predicate: this.ptrePredicates.get(row.slug) }));

      // A GM passes `user:gm` rows; never preselect one on their behalf.
      const current = this.evolutions.current;
      const speciesSlug = actor.species.slug;
      if (game.user.isGM && current?.slug !== speciesSlug) {
        options.delete("user:gm");
        if (!passes(this.ptrePredicates.get(current.slug), options)) {
          this.evolutions.current =
            this.evolutions.available.find((e) => e.slug === speciesSlug) ?? current;
          result = await originalRefresh.apply(this, args);
        }
        options.add("user:gm");
      }

      if (game.user.isGM) restoreBlockedRows(this, effective, options);
    } catch (error) {
      console.error(`${MODULE_ID} | evolution add-ons failed`, error);
    }

    return result;
  };

  if (typeof originalFinalize === "function") {
    proto.finalize = async function (...args) {
      const result = await originalFinalize.apply(this, args);
      try {
        await consumeEvolutionItems(this, result);
      } catch (error) {
        console.error(`${MODULE_ID} | failed to consume the evolution item`, error);
      }
      return result;
    };
  }

  proto.ptreEvolutionPatched = true;
  return true;
}

Hooks.once("setup", async () => {
  if (game.system.id !== "ptu" || !featureEnabled("evolutionAddons")) return;
  try {
    ({ PTUPredicate } = await import("/systems/ptu/src/module/system/predication.js"));
    const { LevelUpData } = await import("/systems/ptu/src/module/apps/level-up-form/document.js");
    if (patchLevelUpData(LevelUpData?.prototype)) {
      console.log(`${MODULE_ID} | evolution add-ons installed (LevelUpData#refresh).`);
    }
  } catch (error) {
    console.error(`${MODULE_ID} | could not patch LevelUpData; evolution add-ons NOT installed.`, error);
  }
});

/** GM view: disable rows restoreBlockedRows() put back, with the reason. */
Hooks.on("renderLevelUpForm", (app, html) => {
  if (!game.user?.isGM || !featureEnabled("evolutionAddons")) return;
  const entries = app?.data?.evolutions?.available;
  if (!entries?.length) return;

  // Never reference the jQuery global; html may be jQuery or a bare element.
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

/**
 * Legacy data check. Migration 121 turned Level / gender / Item into predicates
 * and DROPPED every other restriction (party:, loyalty>=, stat:, gm, stone
 * names…). The old `other.restrictions` survive in the source until the species
 * sheet is next saved, which erases them. Log what was lost, with a suggested
 * predicate, so the GM can re-enter it.
 */
const STAT_ALIASES = {
  hp: "hp", health: "hp", atk: "atk", attack: "atk", def: "def", defense: "def",
  defence: "def", spatk: "spatk", specialattack: "spatk", spa: "spatk", spdef: "spdef",
  specialdefense: "spdef", specialdefence: "spdef", spd: "spd", speed: "spd",
};
const stat = (s) => STAT_ALIASES[norm(s)] ?? norm(s);

function translateRestriction(text, itemSlug) {
  const t = String(text ?? "").trim();
  const key = norm(t);
  if (!key || key === "male" || key === "female") return null;
  if (key === "gm" || key === "gmpermission") return "user:gm";
  let m;
  if ((m = /^party:(.+)$/i.exec(t))) return `party:species:${slugify(m[1])}`;
  if ((m = /^item:(.+)$/i.exec(t))) return `item:${itemSlug(m[1])}`;
  if ((m = /^move-?type:(.+)$/i.exec(t))) return `self:movetype:${norm(m[1])}`;
  if ((m = /^(?:condition|effect|status):(.+)$/i.exec(t))) return `condition:${slugify(m[1])}`;
  if ((m = /^stat:(levelup:)?([a-z]+)\s*([<>=])\s*([a-z]+)$/i.exec(t)))
    return `self:stat:${m[1] ? "levelup:" : ""}${stat(m[2])}${m[3]}${stat(m[4])}`;
  if ((m = /^stat:(?:total:)?([a-z]+)\s*>=\s*(\d+)$/i.exec(t))) return `self:stat:${stat(m[1])}:${m[2]}+`;
  if ((m = /^(loyalty|friendship|level)\s*>=\s*(\d+)$/i.exec(t))) return `self:${m[1].toLowerCase()}:${m[2]}+`;
  if (t.includes(":") || t.startsWith("[")) return t;
  return `item:${itemSlug(t)}`;
}

/**
 * Legacy evolution report — on demand only (it used to run on every load with a
 * permanent warning). From the console:
 *   game.modules.get("PTRe1-Adjustment-Modules").api.legacyEvolutionReport()
 * Lists legacy restrictions / Item-cell entries PTR's migration 121 dropped, with
 * the predicate to add. Returns the rows.
 */
async function legacyEvolutionReport() {
  if (game.system.id !== "ptu") return [];

  const species = [
    ...game.items.filter((i) => i.type === "species"),
    ...game.actors.contents.flatMap((a) => a.itemTypes?.species ?? []),
  ];
  const rows = species.flatMap((item) =>
    (item._source.system?.evolutions ?? []).map((row) => ({ item, row }))
  );
  const legacy = ({ row }) =>
    (row.other?.restrictions ?? []).some((t) => translateRestriction(t, slugify)) ||
    (row.other?.evolutionItem?.type && row.other.evolutionItem.type !== "item");
  if (!rows.some(legacy)) {
    ui.notifications.info("PTRe1: no legacy evolution restrictions found.");
    return [];
  }

  // Resolve bare names ("Thunderstone") to real item slugs ("thunder-stone").
  const slugs = new Map();
  for (const pack of game.packs.filter((p) => p.documentName === "Item")) {
    for (const entry of await pack.getIndex({ fields: ["system.slug", "type"] })) {
      if (entry.type === "item") slugs.set(norm(entry.name), entry.system?.slug || slugify(entry.name));
    }
  }
  for (const item of game.items.filter((i) => i.type === "item")) slugs.set(norm(item.name), item.slug);
  const itemSlug = (name) => slugs.get(norm(name)) ?? slugify(name);

  const lost = [];
  for (const { item, row } of rows) {
    // Migration 121 wrote every Item-cell entry as item:<slug>, including the
    // abilities, moves and conditions our widened drop target recorded.
    const dropped = row.other?.evolutionItem;
    if (dropped?.type && dropped.type !== "item" && dropped.slug) {
      const add = `${dropped.type}:${dropped.slug}`;
      if (!(row.predicate ?? []).includes(add)) {
        lost.push({
          species: item.parent ? `${item.parent.name} (${item.name})` : item.name,
          evolution: row.slug,
          was: `${dropped.name ?? dropped.slug} (${dropped.type}, Item cell)`,
          add: `${add}  — and remove item:${slugify(dropped.slug)}`,
        });
      }
    }

    for (const text of row.other?.restrictions ?? []) {
      const add = translateRestriction(text, itemSlug);
      if (add && !(row.predicate ?? []).includes(add)) {
        lost.push({
          species: item.parent ? `${item.parent.name} (${item.name})` : item.name,
          evolution: row.slug,
          was: text,
          add,
        });
      }
    }
  }
  if (!lost.length) {
    ui.notifications.info("PTRe1: no legacy evolution restrictions found.");
    return [];
  }

  console.warn(
    `${MODULE_ID} | ${lost.length} evolution restriction(s) were dropped by PTR's predicate migration. ` +
      `Add the suggested predicate on each species sheet; saving the sheet erases the old text.`
  );
  console.table(lost);
  ui.notifications.info(`PTRe1: ${lost.length} legacy evolution restriction(s) listed in the console (F12).`);
  return lost;
}

Hooks.once("init", () => {
  const module = game.modules.get(MODULE_ID);
  module.api ??= {};
  module.api.legacyEvolutionReport = legacyEvolutionReport;
});
