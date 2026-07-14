/**
 * SRT Gift Keyword Bridge — PTRe1-Adjustment-Modules add-on
 * ---------------------------------------------------------
 * The Stylish Relationship Tracker gift matcher reads tags from
 * flags.stylish-relationship-tracker.giftTags (and a few other paths) but NOT
 * from PTU's native system.keywords. This mirrors each item's keywords into
 * that flag (lowercased, merge-only — it never removes custom tags you added),
 * so item keywords act as gift tags world-wide with no hand-tagging.
 *
 * Install: drop this file in scripts/ and add it to module.json "esmodules".
 */
 
const SRT = "stylish-relationship-tracker";
const norm = (s) => String(s ?? "").trim().toLowerCase();
const keywordsOf = (item) =>
  Array.isArray(item?.system?.keywords) ? item.system.keywords.map(norm).filter(Boolean) : [];
 
async function syncItem(item) {
  if (item?.documentName !== "Item") return false;
  const tags = keywordsOf(item);
  if (!tags.length) return false;
  const current = (item.getFlag(SRT, "giftTags") || []).map(norm);
  const next = Array.from(new Set([...current, ...tags]));
  if (next.length === current.length && next.every((t) => current.includes(t))) return false;
  await item.setFlag(SRT, "giftTags", next);
  return true;
}
 
Hooks.once("ready", async () => {
  // Keep new/edited items in sync going forward (all clients register; writes are GM-authoritative).
  for (const hook of ["createItem", "updateItem"]) {
    Hooks.on(hook, (doc) => { syncItem(doc).catch((e) => console.warn(`${SRT} | keyword bridge sync failed`, e)); });
  }
 
  // One-time backfill of existing items — GM only, idempotent (skips already-synced items).
  if (!game.user?.isGM) return;
  try {
    let n = 0;
    for (const item of game.items) if (await syncItem(item)) n++;
    for (const actor of game.actors) for (const item of actor.items) if (await syncItem(item)) n++;
    if (n > 0) console.log(`${SRT} | keyword bridge: synced ${n} item(s) on load.`);
  } catch (e) {
    console.error(`${SRT} | keyword bridge backfill error`, e);
  }
});