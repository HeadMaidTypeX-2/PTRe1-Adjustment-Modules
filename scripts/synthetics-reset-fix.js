/**
 * Synthetics reset fix — TypeOverwrite, AP, EphemeralEffect, Token* (ptu 4.4.3.46+)
 * ---------------------------------------------------------------------------------
 * 4.4.3.46 made `PTUActor#prepareSynthetics` reset every rule-element synthetic
 * (actor/base.js:403-421) to stop beforePrepareData rules from doubling up, since
 * `prepareDerivedData` (which calls it) runs twice per `prepareData`:
 *
 *   prepareData()
 *     constructed = false
 *     super.prepareData()  -> prepareDerivedData() -> prepareSynthetics()   pass 1
 *     constructed = true
 *     afterPrepareData() for rules with priority <= 100     <- writes here
 *     prepareDerivedData() -> prepareSynthetics()                           pass 2
 *                                         ^ reset wipes what was just written
 *     afterPrepareData() for rules with priority > 100
 *
 * Rule elements that write synthetics in afterPrepareData at the default
 * priority (100) therefore lose their output before pass 2 uses it:
 *   TypeOverwrite                   synthetics.typeOverride    (Pokémon typing, actor.types)
 *   AP (drain / bind)               synthetics.apAdjustments
 *   EphemeralEffect                 synthetics.ephemeralEffects
 *   TokenImage / TokenLight / Name  synthetics.tokenOverrides
 *
 * This wraps prepareSynthetics: on pass 2 (`this.constructed === true`) those
 * four synthetics are carried over the reset. Pass 1 still resets everything,
 * so nothing goes stale between preparation cycles, and the beforePrepareData
 * synthetics the reset was added for are untouched. No rule element writes
 * these four in beforePrepareData (checked at 4.4.3.46), so nothing doubles.
 *
 * If PTR fixes this upstream the wrapper is redundant but harmless.
 */

import { featureEnabled } from "./feature-toggles.js";

const MODULE_ID = "PTRe1-Adjustment-Modules";
const TARGET = "CONFIG.PTU.Actor.documentClass.prototype.prepareSynthetics";

// Synthetics written in afterPrepareData that must survive into pass 2.
const PRESERVE = ["typeOverride", "apAdjustments", "ephemeralEffects", "tokenOverrides"];

function prepareSynthetics(wrapped, ...args) {
  const kept = this.constructed === true && this.synthetics
    ? PRESERVE.map((key) => [key, this.synthetics[key]])
    : null;
  const result = wrapped(...args);
  if (kept) for (const [key, value] of kept) if (value !== undefined) this.synthetics[key] = value;
  return result;
}

Hooks.once("setup", () => {
  if (game.system.id !== "ptu" || !featureEnabled("syntheticsResetFix")) return;
  if (typeof CONFIG.PTU?.Actor?.documentClass?.prototype?.prepareSynthetics !== "function") {
    console.warn(`${MODULE_ID} | PTUActor#prepareSynthetics not found; synthetics reset fix not installed.`);
    return;
  }
  libWrapper.register(MODULE_ID, TARGET, prepareSynthetics, "WRAPPER");
  console.log(`${MODULE_ID} | synthetics reset fix installed (TypeOverwrite, AP, EphemeralEffect, Token*).`);
});
