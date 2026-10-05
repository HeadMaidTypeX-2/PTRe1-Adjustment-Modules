/**
 * Reinforcements Platform — "Round End" trigger
 * ---------------------------------------------
 * Dylan's General Automations (DGA) ships a "Place Reinforcements Platform" tile
 * tool whose dialog offers three triggers: Via Script, Scene Creation and Round
 * End. Only the first two are implemented — nothing in DGA reads "round", so a
 * Round End platform never fires.
 *
 * This implements it. At the end of every combat round, on the combat's scene,
 * each enabled platform with trigger "round" spawns ONE reinforcement (random
 * pick from its Actors / Roll Tables, same as DGA) and adds it to the combat.
 * The tile stays, so it fires again every round until disabled or deleted.
 *
 * Tile Config gains a "Reinforcements" fieldset on any platform tile:
 *   - Trigger  (DGA's own flag, so existing platforms can be switched to Round End)
 *   - Enabled  (DGA's own flag; untick to stop a platform without deleting it)
 *   - From end of round N  (stored in THIS module's flags; default 1)
 *
 *   - Spawn unlinked tokens  (THIS module's flag; default on)
 *
 * Spawn unlinked: PTR forces every actor's prototype token to be linked
 * (actor/base.js createDocuments, rules/helpers.js preUpdate, migration 110),
 * so every spawn from one actor would share one sheet — damage one, damage all.
 * With this on, the spawned TOKEN is created with actorLink: false, giving each
 * reinforcement its own synthetic copy. Only the token is unlinked; the actor is
 * untouched. The toggle also appears in DGA's placement dialog.
 *
 * Also fixed relative to DGA's spawn: compendium actors are imported to the
 * world once and reused (a token needs a world actor as its base), and a Round
 * End platform whose cell is occupied waits instead of stacking tokens.
 *
 * DGA's api.scripts.SpawnReinforcement (the "Via Script" trigger) is replaced
 * with this spawn so it honours the toggle. DGA's "Scene Creation" trigger calls
 * its own internal copy and is NOT covered.
 *
 * Round End runs on the single active GM only. No-op unless DGA is active.
 */

import { DGA, POKEMON_ASSETS, afterModuleInit } from "./dylan-modules.js";

const MODULE_ID = "PTRe1-Adjustment-Modules";
const ROUND_FLAG = "reinforcementRound";
const UNLINK_FLAG = "spawnUnlinked";

// Set to false to let a platform spawn even when a token already stands on it.
const WAIT_WHILE_OCCUPIED = true;

const dgaActive = () => !!game.modules.get(DGA)?.active;
const isActiveGM = () => !!game.user && game.user === game.users.activeGM;
const platformFlag = (tile) => tile?.getFlag?.(DGA, "reinforcements") ?? null;
const startRound = (tile) => Math.max(1, Number(tile.getFlag(MODULE_ID, ROUND_FLAG)) || 1);
const spawnUnlinked = (tile) => tile.getFlag(MODULE_ID, UNLINK_FLAG) ?? true;

/* ------------------------------------------------------------------ *
 *  Spawning
 * ------------------------------------------------------------------ */

/** Random Actor from the platform's list, rolling any Roll Table entries. */
async function pickActor(uuids) {
  const pool = [...(uuids ?? [])];
  while (pool.length) {
    const [uuid] = pool.splice(Math.floor(Math.random() * pool.length), 1);
    let doc = await fromUuid(uuid).catch(() => null);
    if (doc?.documentName === "RollTable") {
      const { results } = await doc.roll();
      const resultUuid = results?.length === 1 ? results[0].documentUuid : null;
      doc = resultUuid ? await fromUuid(resultUuid).catch(() => null) : null;
    }
    if (doc?.documentName === "Actor") return doc;
  }
  return null;
}

/** Tokens need a world actor as their base; import compendium actors once and reuse them. */
async function toWorldActor(actor) {
  if (!actor.pack) return actor;
  const existing = game.actors.find(
    (a) => (a._stats?.compendiumSource ?? a.flags?.core?.sourceId) === actor.uuid
  );
  if (existing) return existing;
  return game.actors.importFromCompendium(game.packs.get(actor.pack), actor.id);
}

function cellOccupied(scene, x, y) {
  const { sizeX, sizeY } = scene.grid;
  return scene.tokens.some((t) =>
    x < t.x + (t.width ?? 1) * sizeX && t.x < x + sizeX &&
    y < t.y + (t.height ?? 1) * sizeY && t.y < y + sizeY
  );
}

async function spawnFromPlatform(tile, { combat = null, deleteOnSuccess = false, waitIfOccupied = false } = {}) {
  tile = tile?.document ?? tile;
  const scene = tile?.parent;
  if (!scene) return;
  const { sizeX, sizeY } = scene.grid;
  // Same cell maths as DGA's SpawnReinforcement (snapToGrid without isTile).
  const x = Math.floor(tile.x / sizeX) * sizeX;
  const y = Math.floor(tile.y / sizeY) * sizeY;
  if (waitIfOccupied && cellOccupied(scene, x, y)) return;

  const picked = await pickActor(platformFlag(tile)?.uuids);
  if (!picked) return;
  const actor = await toWorldActor(picked);
  if (!actor) return;

  const tokenData = (await actor.getTokenDocument({ x, y })).toObject();
  if (spawnUnlinked(tile)) tokenData.actorLink = false;
  const [token] = await scene.createEmbeddedDocuments("Token", [tokenData]);
  if (token && deleteOnSuccess) await tile.delete();
  if (!token || !combat) return;
  await combat.createEmbeddedDocuments("Combatant", [{
    tokenId: token.id,
    sceneId: scene.id,
    actorId: token.actorId,
    hidden: token.hidden,
  }]);
}

/* ------------------------------------------------------------------ *
 *  Round-end detection
 * ------------------------------------------------------------------ */

Hooks.on("updateCombat", async (combat, changed, options) => {
  if (!("round" in changed) || !dgaActive() || !isActiveGM()) return;
  // Forward only: nextRound / nextTurn pass direction 1, previousRound passes -1.
  const prev = combat.previous?.round;
  const forward = options?.direction !== undefined ? options.direction > 0 : (prev ?? 0) < changed.round;
  if (!forward) return;
  const ended = changed.round - 1;
  if (ended < 1) return; // round 0 -> 1 is combat starting, not a round ending

  const scene = combat.scene ?? combat.combatants.contents.find((c) => c.token)?.token?.parent;
  if (!scene) return;

  const platforms = scene.tiles.filter((t) => {
    const f = platformFlag(t);
    return f?.enabled && f.trigger === "round" && f.uuids?.length && ended >= startRound(t);
  });
  for (const tile of platforms) {
    try {
      await spawnFromPlatform(tile, { combat, waitIfOccupied: WAIT_WHILE_OCCUPIED });
    } catch (err) {
      console.error(`${MODULE_ID} | Round End reinforcement failed for tile ${tile.uuid}`, err);
    }
  }
});

/* ------------------------------------------------------------------ *
 *  Tile Config fields
 * ------------------------------------------------------------------ */

Hooks.on("renderTileConfig", (app, html) => {
  if (!dgaActive()) return;
  const root = typeof html?.querySelector === "function" ? html : html?.[0];
  const tile = app.document ?? app.object;
  const flag = platformFlag(tile);
  if (!root || !flag) return;

  root.querySelector(".ptre1-reinforcements")?.remove();
  const base = `flags.${DGA}.reinforcements`;
  const trigger = flag.trigger ?? "script";
  const opt = (value, label) =>
    `<option value="${value}" ${trigger === value ? "selected" : ""}>${label}</option>`;

  const fieldset = document.createElement("fieldset");
  fieldset.classList.add("ptre1-reinforcements");
  fieldset.innerHTML = `
    <legend>Reinforcements</legend>
    <div class="form-group">
      <label>Trigger</label>
      <div class="form-fields">
        <select name="${base}.trigger">
          ${opt("script", "Via Script")}${opt("scene", "Scene Creation")}${opt("round", "Round End")}
        </select>
      </div>
    </div>
    <div class="form-group">
      <label>Enabled</label>
      <div class="form-fields">
        <input type="checkbox" name="${base}.enabled" ${flag.enabled ? "checked" : ""}>
      </div>
    </div>
    <div class="form-group">
      <label>From end of round</label>
      <div class="form-fields">
        <input type="number" name="flags.${MODULE_ID}.${ROUND_FLAG}" min="1" step="1" value="${startRound(tile)}">
      </div>
      <p class="hint">Round End only. Spawns one reinforcement at the end of this round and every round after, and adds it to the combat.</p>
    </div>
    <div class="form-group">
      <label>Spawn unlinked tokens</label>
      <div class="form-fields">
        <input type="checkbox" name="flags.${MODULE_ID}.${UNLINK_FLAG}" ${spawnUnlinked(tile) ? "checked" : ""}>
      </div>
      <p class="hint">Each reinforcement gets its own copy of the actor. Untick to spawn linked tokens that share one sheet. Not applied by the Scene Creation trigger.</p>
    </div>`;

  const footer = root.querySelector("footer.form-footer, footer");
  if (footer) footer.before(fieldset);
  else (root.querySelector("form") ?? root).append(fieldset);
  app.setPosition?.({ height: "auto" });
});

/* ------------------------------------------------------------------ *
 *  Placement dialog toggle
 * ------------------------------------------------------------------ */

// DGA's "Actors To Spawn" dialog only reads its own fields, so the checkbox's
// state is held here and stamped onto the platform tile as DGA creates it.
let pendingUnlinked;

Hooks.on("renderDialogV2", (app, html) => {
  if (!dgaActive()) return;
  const root = typeof html?.querySelector === "function" ? html : app.element;
  const trigger = root?.querySelector('select[name="trigger"]');
  if (!trigger || !root.querySelector('item-drop-zone[allowed="Actor"]')) return;
  if (root.querySelector(".ptre1-spawn-unlinked")) return;

  pendingUnlinked = true;
  const row = document.createElement("div");
  row.classList.add("form-group", "ptre1-spawn-unlinked");
  row.innerHTML = `
    <label>Spawn unlinked tokens</label>
    <div class="form-fields"><input type="checkbox" checked></div>`;
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

/* ------------------------------------------------------------------ *
 *  "Via Script" trigger
 * ------------------------------------------------------------------ */

// Same signature as DGA's SpawnReinforcement(tile, { deleteOnSuccess }).
function SpawnReinforcement(tile, { deleteOnSuccess = false } = {}) {
  return spawnFromPlatform(tile, { deleteOnSuccess });
}

function installSpawn(module) {
  const scripts = module.api?.scripts;
  if (scripts && "SpawnReinforcement" in scripts) scripts.SpawnReinforcement = SpawnReinforcement;
}

Hooks.once("init", () => {
  afterModuleInit(DGA, installSpawn);
  afterModuleInit(POKEMON_ASSETS, installSpawn);
});
