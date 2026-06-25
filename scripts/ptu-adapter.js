/**
 * GlitchSmith / Stylish Shop — PTU System Adapter
 * -----------------------------------------------
 * Stylish Shop reads item data through a per-system adapter. It ships adapters
 * for dnd5e, pf2e, swade, etc., but NOT for PTU (system id "ptu"), so PTU falls
 * back to a generic adapter that reads conventional fields PTU doesn't use.
 *
 * This registers a real PTU adapter via the shop's public registerSystemAdapter
 * API. It reuses the existing fallback adapter for everything (currency, rarity,
 * etc.) and overrides only the item-level fields PTU stores differently:
 *
 *   getDescription() -> system.effect || system.referenceEffect || system.snippet
 *   getPrice()       -> system.cost   (PTU item price, an integer)
 *
 * Reads STORED fields only, so it works on live items and the shop's saved
 * snapshots alike. No libWrapper, no prepareDerivedData, no writes to items.
 *
 * NOTE — Currency is configured, not coded. For shops to take a trainer's money,
 * define a sheet currency in the GlitchSmith Library currency dialog pointing at
 * the trainer money path:  system.money  (integer).
 */
 
const MODULE_ID = "PTRe1-Adjustment-Modules";
const SHOP_ID = "stylish-shop";
const DESCRIPTION_FIELDS = ["effect", "referenceEffect", "snippet"]; // first non-empty wins
const PRICE_FIELD = "cost"; // PTU item price (integer)
 
Hooks.once("ready", () => {
  if (game.system.id !== "ptu") return;
 
  const api = game.modules.get(SHOP_ID)?.api;
  if (!api?.registerSystemAdapter || !api?.getSystemAdapter) {
    console.warn(`${MODULE_ID} | Stylish Shop API not available; PTU adapter not registered.`);
    return;
  }
 
  try {
    // Reuse whatever adapter PTU currently falls back to, so currency / pricing
    // config / display behaviour is untouched.
    const baseAdapter = api.getSystemAdapter("ptu");
    const BaseSystemAdapter = baseAdapter.constructor;
    const BaseItemAdapter = baseAdapter.createItemAdapter({ system: {} }).constructor;
 
    class PtuItemAdapter extends BaseItemAdapter {
      getDescription() {
        const s = this.sys ?? {};
        for (const key of DESCRIPTION_FIELDS) {
          const v = s[key];
          if (typeof v === "string" && v.trim().length) return v;
        }
        return super.getDescription();
      }
 
      getPrice() {
        const c = this.sys?.[PRICE_FIELD];
        if (typeof c === "number") return c;
        const n = Number(c);
        if (Number.isFinite(n)) return n;
        return super.getPrice();
      }
    }
 
    class PtuSystemAdapter extends BaseSystemAdapter {
      createItemAdapter(item) {
        return new PtuItemAdapter(item, this);
      }
    }
 
    api.registerSystemAdapter("ptu", () => new PtuSystemAdapter("ptu"));
    console.log(`${MODULE_ID} | Registered PTU shop adapter (description: ${DESCRIPTION_FIELDS.join(" || ")}; price: system.${PRICE_FIELD}).`);
  } catch (e) {
    console.error(`${MODULE_ID} | Failed to register PTU shop adapter:`, e);
  }
});