/**
 * Reinforcements Platform — unlinked spawns (DGA 1.0.8+)
 * ------------------------------------------------------
 * DGA 1.0.8 ships the Round End trigger, start round, wait-while-occupied,
 * compendium import and combatant adding natively (features/reinforcements.mjs),
 * plus its own Reinforcements fieldset in Tile Config. This module's earlier
 * Round End handler is gone: running both spawned every platform twice a round.
 *
 * What DGA still lacks is unlinked spawning. PTR forces every actor's prototype
 * token to be linked (actor/base.js createDocuments, rules/helpers.js preUpdate),
 * so every reinforcement spawned from one actor shares one sheet — damage one,
 * damage all. With "Spawn unlinked tokens" ticked (per tile, default on) the
 * spawned TOKEN is created with actorLink: false, giving each its own copy. The
 * actor itself is untouched.
 *
 * DGA spawns through an internal function this module can't wrap, so the token
 * is unlinked as it is created: a `preCreateToken` on the spawning client, for a
 * token landing exactly on an unlink-enabled platform's cell, within a short
 * window "armed" by each trigger:
 *   - Round End       a forward round advance on that scene (updateCombat)
 *   - Scene Creation  the scene being created (createScene)
 *   - Via Script      a call to api.scripts.SpawnReinforcement (wrapped; DGA's
 *                     own function still does the spawning)
 * A GM dragging a token onto a hidden platform outside those moments is unaffected.
 *
 * UI: the toggle is added to DGA's placement dialog and to DGA's Reinforcements
 * fieldset in Tile Config.
 *
 * Migration: platforms set up with this module's old Round End fields stored the
 * start round under this module's flag. On load the active GM copies it into
 * DGA's flag where DGA's is unset (copy only; nothing is deleted).
 *
 * No-op unless DGA is active.
 */

import { featureEnabled } from "./feature-toggles.js";
import { DGA, POKEMON_ASSETS, afterModuleInit } from "./dylan-modules.js";

const MODULE_ID = "PTRe1-Adjustment-Modules";
const UNLINK_FLAG = "spawnUnlinked";
const LEGACY_ROUND_FLAG = "reinforcementRound";
const ARM_MS = 15000; // first-time compendium imports can take a few seconds

const dgaActive = () => !!game.modules.get(DGA)?.active;
const enabled = () => dgaActive() && featureEnabled("reinforcements");
const platformFlag = (tile) => tile?.getFlag?.(DGA, "reinforcements") ?? null;
const spawnUnlinked = (tile) => tile.getFlag(MODULE_ID, UNLINK_FLAG) ?? true;

/* ------------------------------------------------------------------ *
 *  Arming: scene id -> expiry time
 * ------------------------------------------------------------------ */

const armed = new Map();
const arm = (scene) => { if (scene?.id) armed.set(scene.id, Date.now() + ARM_MS); };
const isArmed = (scene) => (armed.get(scene?.id) ?? 0) > Date.now();

// Same forward-round test as DGA's Round End handler. Registered at load, so it
// runs before DGA's (registered in DGA's init) and arms before any spawn starts.
Hooks.on("updateCombat", (combat, changed, options) => {
  if (!("round" in changed) || !enabled()) return;
  const prev = combat.previous?.round ?? 0;
  const forward = options?.direction !== undefined ? options.direction > 0 : prev < changed.round;
  if (!forward || changed.round - 1 < 1) return;
  arm(combat.scene ?? combat.combatants.contents.find((c) => c.token)?.token?.parent);
});

Hooks.on("createScene", (scene) => { if (enabled()) arm(scene); });

/* ------------------------------------------------------------------ *
 *  Unlink at creation
 * ------------------------------------------------------------------ */

/** Top-left of the platform's cell, the same maths as DGA's snapToGrid (no isTile). */
function platformCell(tile, grid) {
  return { x: Math.floor(tile.x / grid.sizeX) * grid.sizeX, y: Math.floor(tile.y / grid.sizeY) * grid.sizeY };
}

Hooks.on("preCreateToken", (token) => {
  try {
    const scene = token.parent;
    if (!enabled() || !isArmed(scene) || token.actorLink === false) return;
    const onPlatform = scene.tiles.some((tile) => {
      if (!platformFlag(tile) || !spawnUnlinked(tile)) return false;
      const cell = platformCell(tile, scene.grid);
      return cell.x === token.x && cell.y === token.y;
    });
    if (onPlatform) token.updateSource({ actorLink: false });
  } catch (err) {
    console.error(`${MODULE_ID} | reinforcement unlink check failed; token left as-is.`, err);
  }
});

/* ------------------------------------------------------------------ *
 *  "Via Script": arm, then let DGA's own function spawn
 * ------------------------------------------------------------------ */

function installSpawn(module) {
  const scripts = module.api?.scripts;
  const original = scripts?.SpawnReinforcement;
  if (typeof original !== "function" || original.ptre1Wrapped) return;
  const wrapped = function (tile, ...rest) {
    if (enabled()) arm((tile?.document ?? tile)?.parent);
    return original.call(this, tile, ...rest);
  };
  wrapped.ptre1Wrapped = true;
  scripts.SpawnReinforcement = wrapped;
}

Hooks.once("init", () => {
  afterModuleInit(DGA, installSpawn);
  afterModuleInit(POKEMON_ASSETS, installSpawn);
});

/* ------------------------------------------------------------------ *
 *  UI: placement dialog + DGA's Tile Config fieldset
 * ------------------------------------------------------------------ */

// DGA's "Actors To Spawn" dialog only reads its own fields, so the checkbox's
// state is held here and stamped onto the platform tile as DGA creates it.
let pendingUnlinked;

Hooks.on("renderDialogV2", (app, html) => {
  if (!enabled()) return;
  const root = typeof html?.querySelector === "function" ? html : app.element;
  const trigger = root?.querySelector('select[name="trigger"]');
  if (!trigger || !root.querySelector('item-drop-zone[allowed="Actor"]')) return;
  if (root.querySelector(".ptre1-spawn-unlinked")) return;

  pendingUnlinked = true;
  const row = document.createElement("div");
  row.classList.add("form-group", "ptre1-spawn-unlinked");
  row.innerHTML = `
    <label>Spawn unlinked tokens</label>
    <div class="form-fields"><input type="checkbox" checked></div>
    <p class="hint">Each reinforcement gets its own copy of the actor instead of sharing one sheet.</p>`;
  row.querySelector("input").addEventListener("change", (e) => { pendingUnlinked = e.target.checked; });
  (trigger.closest(".form-group") ?? trigger).after(row);
  app.setPosition?.({ height: "auto" });
});

// Read the flag off the document: DGA passes it as a dotted key in the raw data.
Hooks.on("preCreateTile", (tile) => {
  if (pendingUnlinked === undefined || !tile.flags?.[DGA]?.reinforcements) return;
  tile.updateSource({ [`flags.${MODULE_ID}.${UNLINK_FLAG}`]: pendingUnlinked });
  pendingUnlinked = undefined;
});

Hooks.on("renderTileConfig", (app, html) => {
  if (!enabled()) return;
  const root = typeof html?.querySelector === "function" ? html : html?.[0];
  const tile = app.document ?? app.object;
  if (!root || !platformFlag(tile)) return;

  root.querySelector(".ptre1-spawn-unlinked")?.remove();
  const row = document.createElement("div");
  row.classList.add("form-group", "ptre1-spawn-unlinked");
  row.innerHTML = `
    <label>Spawn unlinked tokens</label>
    <div class="form-fields">
      <input type="checkbox" name="flags.${MODULE_ID}.${UNLINK_FLAG}" ${spawnUnlinked(tile) ? "checked" : ""}>
    </div>
    <p class="hint">Each reinforcement gets its own copy of the actor instead of sharing one sheet.</p>`;

  // Prefer DGA's own Reinforcements fieldset; fall back to one of our own.
  const fieldset = root.querySelector("fieldset.dga-reinforcements");
  if (fieldset) fieldset.append(row);
  else {
    const own = document.createElement("fieldset");
    own.classList.add("ptre1-spawn-unlinked");
    own.innerHTML = "<legend>Reinforcements</legend>";
    own.append(row);
    const footer = root.querySelector("footer.form-footer, footer");
    if (footer) footer.before(own);
    else (root.querySelector("form") ?? root).append(own);
  }
  app.setPosition?.({ height: "auto" });
});

/* ------------------------------------------------------------------ *
 *  One-time migration of the old start-round flag
 * ------------------------------------------------------------------ */

Hooks.once("ready", async () => {
  if (!dgaActive() || game.user !== game.users.activeGM) return;
  let copied = 0;
  for (const scene of game.scenes) {
    const updates = scene.tiles
      .filter((t) => platformFlag(t)
        && t.getFlag(MODULE_ID, LEGACY_ROUND_FLAG) !== undefined
        && t.getFlag(DGA, LEGACY_ROUND_FLAG) === undefined)
      .map((t) => ({ _id: t.id, [`flags.${DGA}.${LEGACY_ROUND_FLAG}`]: t.getFlag(MODULE_ID, LEGACY_ROUND_FLAG) }));
    if (!updates.length) continue;
    await scene.updateEmbeddedDocuments("Tile", updates);
    copied += updates.length;
  }
  if (copied) console.log(`${MODULE_ID} | copied the start round of ${copied} reinforcement platform(s) into DGA's own setting.`);
});
