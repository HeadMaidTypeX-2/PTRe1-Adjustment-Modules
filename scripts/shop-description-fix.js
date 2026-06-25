/**
 * Shop / item-description fix
 * ---------------------------
 * PTU keeps an item's description text in `system.effect`. Most system-agnostic
 * modules — including GlitchSmith's Stylish Shop auto-extractor — read the
 * conventional `system.description.value`, find nothing on a PTU item, and
 * report "No description could be extracted from the source item."
 *
 * At derived-data time we copy `system.effect` into `system.description.value`.
 * This is IN-MEMORY ONLY — prepareDerivedData runs on every load/update and
 * never writes to the database, so the stored item and the PTU data model are
 * left completely untouched.
 *
 * NOTE: This reaches modules that read the LIVE item document. If Stylish Shop
 * reads the item's source data (item.toObject() / item._source) instead, this
 * won't reach it and we'd wrap the shop's own extractor directly instead.
 */

const SOURCE_FIELD = "system.effect";   // where PTU stores the text
const TARGET_KEY   = "description";      // -> system.description.value

Hooks.once("setup", () => {
  if (game.system.id !== "ptu") return;

  if (!game.modules.get("lib-wrapper")?.active) {
    console.error("PTU Table Toolkit | Shop description fix: libWrapper is required but not active.");
    return;
  }

  libWrapper.register(
    "ptr-capability-ruler",
    "CONFIG.Item.documentClass.prototype.prepareDerivedData",
    function (wrapped, ...args) {
      const result = wrapped(...args);
      try {
        const sys = this.system;
        const text = foundry.utils.getProperty(this, SOURCE_FIELD);
        if (sys && typeof text === "string" && text.length) {
          const desc = sys[TARGET_KEY];
          if (!desc || typeof desc !== "object") {
            sys[TARGET_KEY] = { value: text };
          } else if (!desc.value) {
            desc.value = text;
          }
        }
      } catch (e) {
        console.error("PTU Table Toolkit | Shop description fix: failed to mirror description:", e);
      }
      return result;
    },
    "WRAPPER"
  );

  console.log("PTU Table Toolkit | Shop description fix: mirroring system.effect -> system.description.value (derived).");
});
