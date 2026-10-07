/**
 * TypeOverwrite display fix — Pokémon sheet typing (ptu 4.4.3.49)
 * ----------------------------------------------------------------
 * 4.4.3.48 split actor preparation into phases (actor/base.js prepareDerivedData):
 *   prePrepareDerivedData -> onPrepareDerivedData -> postPrepareDerivedData -> cleanup
 * A Pokémon's `system.typing` is computed in onPrepareDerivedData
 * (pokemon/document.js:339-341), but rule elements' afterPrepareData — where
 * TypeOverwrite writes `synthetics.typeOverride.typing` — runs later, in
 * postPrepareDerivedData. So `system.typing` holds the species types.
 *
 * Mechanics are unaffected: they read `actor.types`, which prefers the override
 * (move STAB/damage move/document.js:88,99; type effectiveness base.js:171+).
 * Two places read `system.typing` and show the wrong types:
 *   - the sheet's type icons      (pokemon-sheet-compact.hbs:722)
 *   - the sheet's damage preview  (scripts/handlebars.js:379, STAB)
 *
 * This wraps postPrepareDerivedData and, once the rules have run, copies the
 * override into `system.typing` for Pokémon. Live toggle; takes effect on the
 * actor's next preparation. Redundant once PTR applies the override itself.
 */

import { featureEnabled } from "./feature-toggles.js";

const MODULE_ID = "PTRe1-Adjustment-Modules";
const TARGET = "CONFIG.PTU.Actor.documentClass.prototype.postPrepareDerivedData";

function postPrepareDerivedData(wrapped, ...args) {
  const result = wrapped(...args);
  try {
    const typing = this.synthetics?.typeOverride?.typing;
    if (this.type === "pokemon" && Array.isArray(typing) && typing.length && featureEnabled("typeOverwriteDisplay")) {
      this.system.typing = [...typing];
    }
  } catch (err) {
    console.error(`${MODULE_ID} | TypeOverwrite display fix failed for ${this.name}`, err);
  }
  return result;
}

Hooks.once("setup", () => {
  if (game.system.id !== "ptu") return;
  if (typeof CONFIG.PTU?.Actor?.documentClass?.prototype?.postPrepareDerivedData !== "function") {
    console.warn(`${MODULE_ID} | PTUActor#postPrepareDerivedData not found (PTR older than 4.4.3.48?); TypeOverwrite display fix not installed.`);
    return;
  }
  libWrapper.register(MODULE_ID, TARGET, postPrepareDerivedData, "WRAPPER");
});
