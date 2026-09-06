/**
 * Evolution Drop Targets — let the species sheet's Item column accept anything
 * ----------------------------------------------------------------------------
 * The species sheet already has a per-evolution **Item** drop target, and
 * `evolution-requirements.js` gates on whatever lands there. But the sheet's own
 * `_onDrop` is a `switch (item.type)` and only `case "item"` writes
 * `evolution.other.evolutionItem` (species/sheet.js:311-322). Drop an ability on
 * an evolution row today and it falls into the ability branch instead, quietly
 * adding it to the species' ability list — not what anyone meant.
 *
 * A Pokémon can own `pokeedge`, `move`, `contestmove`, `ability`, `capability`,
 * `effect`, `condition`, `spiritaction` and `item` (pokemon/document.js:24-26),
 * and they are all Foundry Items, so one drop target can express "requires this
 * ability" just as well as "requires this stone".
 *
 * This wraps `PTUSpeciesSheet#_onDrop`: when the drop lands on `.evolution-item`,
 * any acceptable document type is written to `evolutionItem` and the original is
 * never reached. Every other drop is passed straight through untouched.
 *
 * The stored shape gains a `type`, which is what tells the gating module whether
 * the requirement may be **consumed** on evolution — only a real `item` is ever
 * decremented; an ability or Poké Edge is a condition, not a cost.
 *
 *   { slug, uuid, type, name }
 *
 * Entries written before this existed have no `type`; the gating module resolves
 * those by looking at what the actor actually owns.
 */

const MODULE_ID = "PTRe1-Adjustment-Modules";

/** Document types meaningful as an evolution requirement. */
const ACCEPTED_TYPES = new Set([
  "item",
  "ability",
  "move",
  "pokeedge",
  "capability",
  "contestmove",
  "spiritaction",
]);

/** Is this drop landing on an evolution row's Item cell? */
function evolutionRowIndex(event) {
  const target = event?.currentTarget;
  if (!target?.classList?.contains("evolution-item")) return null;
  const index = Number(target.dataset?.index);
  return Number.isInteger(index) ? index : null;
}

async function handleEvolutionDrop(sheet, event, index) {
  let data;
  try {
    data = JSON.parse(event.dataTransfer.getData("text/plain"));
  } catch {
    return false;
  }

  // Intra-sheet reordering carries _category; leave that to the system.
  if (data?._category) return false;

  const document = await Item.implementation.fromDropData(data).catch(() => null);
  if (!document) return false;

  if (!ACCEPTED_TYPES.has(document.type)) {
    ui.notifications?.warn(
      `${document.name} is a "${document.type}" and cannot be an evolution requirement.`
    );
    return true; // handled: refused, but do not fall through to the type switch
  }

  const evolutions = foundry.utils.deepClone(sheet.item.system.evolutions ?? []);
  const row = evolutions[index];
  if (!row) return false;

  const slug = document.system?.slug ?? document.slug ?? null;
  row.other ??= {};
  row.other.evolutionItem = {
    slug,
    uuid: document.uuid,
    type: document.type,
    name: document.name,
  };

  await sheet.item.update({ "system.evolutions": evolutions });
  console.log(
    `${MODULE_ID} | ${sheet.item.name}: ${row.slug} now requires ` +
      `${document.name} (${document.type}).`
  );
  return true;
}

Hooks.once("setup", async () => {
  if (game.system.id !== "ptu") return;

  if (typeof libWrapper === "undefined" || !game.modules.get("lib-wrapper")?.active) {
    return console.error(
      `${MODULE_ID} | lib-wrapper inactive — evolution drop targets NOT extended.`
    );
  }

  let PTUSpeciesSheet;
  try {
    ({ PTUSpeciesSheet } = await import("/systems/ptu/src/module/item/species/sheet.js"));
  } catch (error) {
    return console.error(
      `${MODULE_ID} | could not import PTUSpeciesSheet; drop targets NOT extended.`,
      error
    );
  }

  if (!PTUSpeciesSheet?.prototype?._onDrop) {
    return console.error(`${MODULE_ID} | PTUSpeciesSheet#_onDrop not found.`);
  }

  const original = PTUSpeciesSheet.prototype._onDrop;
  PTUSpeciesSheet.prototype._onDrop = async function (event, ...rest) {
    const index = evolutionRowIndex(event);
    if (index !== null) {
      try {
        if (await handleEvolutionDrop(this, event, index)) return;
      } catch (error) {
        console.error(`${MODULE_ID} | evolution requirement drop failed`, error);
      }
    }
    return original.call(this, event, ...rest);
  };

  console.log(`${MODULE_ID} | evolution drop targets accept abilities, moves and edges.`);
});
