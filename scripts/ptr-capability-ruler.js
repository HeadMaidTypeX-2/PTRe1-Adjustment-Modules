/**
 * PTR Capability Ruler
 * --------------------
 * Foundry V13/V14 already draws the green -> yellow -> red drag-ruler gradient
 * natively. The problem in PTR 1e is that the system never tells core HOW FAR a
 * given Movement Action reaches, so every action falls back to the single global
 * CONFIG.Token.movement.defaultSpeed and the colors never change.
 *
 * This module wraps the two ruler styling methods and re-colors each grid space /
 * segment using the dragged token's ACTUAL capability value, picked according to
 * the Movement Action currently selected on the token.
 *
 * Requires: libWrapper.  System: PTR 1e (ptu).
 */

const MODULE_ID = "ptr-capability-ruler";

/* ------------------------------------------------------------------ *
 *  TUNABLES — edit these to taste.
 * ------------------------------------------------------------------ */

// Set to true ONCE, drag a token, and read the console (F12). It prints the
// real waypoint object + the action id, so you can confirm the field names
// below match your exact build. Set back to false afterward.
const DEBUG = false;

// Foundry's core Movement Action id  ->  PTR capability key on
// actor.system.capabilities.*  (overland, swim, sky, burrow, levitate,
// teleporter ...). The left-hand ids are core's, NOT PTR's labels.
// A value may be a single capability key OR a list — when it's a list, the
// HIGHEST available capability among them is used.
const ACTION_TO_CAPABILITY = {
  walk:    "overland",
  fly:     ["sky", "levitate"],   // use whichever is higher
  swim:    "swim",
  burrow:  "burrow",
  climb:   "overland",
  crawl:   "overland",
  jump:    "overland",
  blink:   "teleporter",   // "Teleport (Blink)" in the dropdown
  displace:"teleporter",
  "":      "overland"      // "Default (Walk)" / auto-determined
};

// What counts as the "yellow" band beyond base movement. PTU has no literal
// "dash", so treat this as your Sprint allowance. 2 = up to double the
// capability is yellow, beyond that is red. Set to 1 to drop the yellow band
// entirely (green then straight to red).
const DASH_MULTIPLIER = 2;

// measurement.cost is already in the scene's distance units. PTU capabilities
// are in meters. If your scene grid is set to 1 meter per square this stays 1.
// If a square is, say, 2 meters, set this to 0.5 (capabilities cover fewer
// squares), etc.
const UNIT_SCALE = 1;

// Colors (hex). Tweak freely.
const COLOR_WITHIN = 0x33bc4e; // green  — reachable this turn
const COLOR_DASH   = 0xe6b800; // yellow — reachable with sprint
const COLOR_BEYOND = 0xcc2b2b; // red    — out of range

/* ------------------------------------------------------------------ *
 *  Logic
 * ------------------------------------------------------------------ */

function getTokenSpeed(ruler) {
  const token = ruler?.token;
  const actor = token?.actor;
  if (!actor) return null;

  const caps = actor.system?.capabilities ?? null;
  if (!caps) return null; // no capability data at all -> can't judge, leave core default

  let action = token.document?.movementAction ?? "";
  if (!(action in ACTION_TO_CAPABILITY)) action = "";

  // The action may map to a single capability or a list; take the highest.
  const mapped = ACTION_TO_CAPABILITY[action] ?? "overland";
  const capKeys = Array.isArray(mapped) ? mapped : [mapped];

  let best = 0;
  let bestKey = capKeys[0];
  for (const key of capKeys) {
    const v = Number(caps[key]);
    if (Number.isFinite(v) && v > best) {
      best = v;
      bestKey = key;
    }
  }

  if (DEBUG) {
    console.log(`${MODULE_ID} | action="${action}" -> [${capKeys.join(", ")}] -> won "${bestKey}" = ${best}`, caps);
  }

  // None of the mapped capabilities exist / all are zero: the Pokemon simply
  // does not have this movement type. Return 0 (not null) so the ruler paints
  // everything red instead of falling back to core's default speed.
  if (best <= 0) return 0;
  return best * UNIT_SCALE;
}

function cumulativeCost(waypoint) {
  const m = waypoint?.measurement;
  // "cost" respects difficult terrain (what core uses); "distance" is the raw fallback.
  const v = m?.cost ?? m?.distance;
  return Number.isFinite(v) ? v : null;
}

function colorFor(cost, speed) {
  if (speed == null || cost == null) return null; // unknown -> don't override
  if (speed <= 0) return COLOR_BEYOND;            // no capability for this action -> all red
  if (cost <= speed) return COLOR_WITHIN;
  if (cost <= speed * DASH_MULTIPLIER) return COLOR_DASH;
  return COLOR_BEYOND;
}

// Shared wrapper for both _getGridHighlightStyle(waypoint, offset)
// and _getSegmentStyle(waypoint). `this` is the TokenRuler instance.
function recolor(wrapped, waypoint, ...rest) {
  const style = wrapped(waypoint, ...rest);
  try {
    if (DEBUG) console.log(`${MODULE_ID} | waypoint`, waypoint, "| style", style);
    if (style && style.alpha !== 0) {
      const speed = getTokenSpeed(this);
      const cost = cumulativeCost(waypoint);
      const c = colorFor(cost, speed);
      if (c != null) style.color = c;
    }
  } catch (err) {
    console.error(`${MODULE_ID} | recolor failed`, err);
  }
  return style;
}

Hooks.once("setup", () => {
  if (!game.modules.get("lib-wrapper")?.active) {
    ui.notifications?.error(`${MODULE_ID}: libWrapper is required but not active.`);
    return;
  }
  if (!CONFIG?.Token?.rulerClass?.prototype) {
    console.error(`${MODULE_ID} | CONFIG.Token.rulerClass not found — your Foundry build may differ.`);
    return;
  }

  libWrapper.register(MODULE_ID, "CONFIG.Token.rulerClass.prototype._getGridHighlightStyle", recolor, "WRAPPER");
  libWrapper.register(MODULE_ID, "CONFIG.Token.rulerClass.prototype._getSegmentStyle", recolor, "WRAPPER");

  console.log(`${MODULE_ID} | ready — ruler now reads PTR capabilities.`);
});