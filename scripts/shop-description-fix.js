/**
 * Shop / item-description fix
 * ---------------------------
 * PTU stores an item's descriptive text in one of two fields, depending on how
 * the item was created:
 *   - system.effect          : inline / user-entered (or override) text
 *   - system.referenceEffect : canonical text carried from the compendium reference
 * Either may hold the description while the other is empty, which is why some
 * shop items pulled text and others didn't. Most system-agnostic modules
 * (GlitchSmith's Stylish Shop included) only read system.description.value, which
 * PTU never populates.
 *
 * At derived-data time we copy the FIRST non-empty field from SOURCE_FIELDS into
 * system.description.value. IN-MEMORY ONLY — prepareDerivedData never writes to
 * the database, so the stored item and the PTU data model are untouched.
 */

// MUST match module.json "id" exactly (case-sensitive).
const MODULE_ID = "PTRe1-Adjustment-Modules";

// Checked in order; first one with real text wins.
const SOURCE_FIELDS = ["system.effect", "system.referenceEffect", "system.snippet"];
const TARGET_KEY = "description"; // -> system.description.value

function firstNonEmpty(doc) {
  for (const path of SOURCE_FIELDS) {
    const v = foundry.utils.getProperty(doc, path);
    if (typeof v === "string" && v.trim().length) return v;
  }
  return null;
}

Hooks.once("setup", () => {
  if (game.system.id !== "ptu") return;

  if (!game.modules.get("lib-wrapper")?.active) {
    console.error(`${MODULE_ID} | Shop description fix: libWrapper is required but not active.`);
    return;
  }

  libWrapper.register(
    MODULE_ID,
    "CONFIG.Item.documentClass.prototype.prepareDerivedData",
    function (wrapped, ...args) {
      const result = wrapped(...args);
      try {
        const sys = this.system;
        const text = firstNonEmpty(this);
        if (sys && text) {
          const desc = sys[TARGET_KEY];
          if (!desc || typeof desc !== "object") {
            sys[TARGET_KEY] = { value: text };
          } else if (!desc.value) {
            desc.value = text;
          }
        }
      } catch (e) {
        console.error(`${MODULE_ID} | Shop description fix: failed to mirror description:`, e);
      }
      return result;
    },
    "WRAPPER"
  );

  console.log(`${MODULE_ID} | Shop description fix: mirroring first of [${SOURCE_FIELDS.join(", ")}] -> system.description.value (derived).`);
});