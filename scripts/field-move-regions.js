/**
 * Rock Climb & Waterfall region behaviors — replaces Pokémon Assets' placement tools
 * --------------------------------------------------------------------------------
 * Pokémon Assets' "Place Climbable Rocks" / "Place Waterfall" region tools create
 * a pair of hidden, LOCKED 1×1 regions (bottom + top) running an executeScript that
 * calls TriggerClimb. They're easy to lose track of, survive "clear regions" because
 * they're locked, and only link two cells.
 *
 * This removes those two tools and adds two Region Behaviors instead, built the
 * same way as Pokémon Assets' Surf:
 *   - "Rock Climb" / "Waterfall" (PTRe1-Adjustment-Modules.rockClimb / .waterfall)
 *   - Add one to any region you draw over the rock face / waterfall.
 *   - Tokens can't walk into the region (like Surf water; toggle per behavior).
 *   - Face the region and Interact: if the party can use the move (same check,
 *     setting and prompt as Pokémon Assets), the token crosses the region in a
 *     straight line in the facing direction and lands on the first cell beyond
 *     it. Works both ways, so the region is the path up AND down.
 *
 * Legacy regions keep working; a GM-only console report on load lists them, and
 *   game.modules.get("PTRe1-Adjustment-Modules").api.removeLegacyClimbRegions()
 * unlocks and deletes them on the viewed scene (pass { allScenes: true } for all).
 *
 * No-op unless Pokémon Assets and DGA are active.
 */

import { DGA, POKEMON_ASSETS, afterModuleInit } from "./dylan-modules.js";

const MODULE_ID = "PTRe1-Adjustment-Modules";
const MAX_CROSS = 100;

// key -> Pokémon Assets field move: i18n key, setting, logic fn, "already used" token flag
const MOVES = {
  rockClimb: { fieldMove: "RockClimb", setting: "canUseRockClimb", logic: "CanUseRockClimb", used: "_climbing", icon: "fa-solid fa-hill-rockslide" },
  waterfall: { fieldMove: "Waterfall", setting: "canUseWaterfall", logic: "CanUseWaterfall", used: "_waterfall", icon: "fa-solid fa-water-arrow-up" },
};
const typeOf = (key) => `${MODULE_ID}.${key}`;

// Tokens mid-crossing are exempt from the movement block, so the climb itself isn't stopped.
const crossing = new Set();

/* ------------------------------------------------------------------ *
 *  Behavior types
 * ------------------------------------------------------------------ */

function makeBehaviorType() {
  return class extends foundry.data.regionBehaviors.RegionBehaviorType {
    static defineSchema() {
      return {
        blockMovement: new foundry.data.fields.BooleanField({
          initial: true,
          label: "Block normal movement",
          hint: "Tokens can't walk into this region; they can only cross it with the field move.",
        }),
      };
    }
  };
}

/** The first enabled Rock Climb / Waterfall behavior on a region, as [key, behavior]. */
function fieldMoveBehavior(region) {
  for (const b of region?.behaviors ?? []) {
    if (b.disabled) continue;
    for (const key of Object.keys(MOVES)) if (b.type === typeOf(key)) return [key, b];
  }
  return [null, null];
}

/* ------------------------------------------------------------------ *
 *  Crossing
 * ------------------------------------------------------------------ */

function partyMember(token, key) {
  const pa = game.modules.get(POKEMON_ASSETS);
  const logic = pa?.api?.logic;
  const { setting, logic: fn } = MOVES[key];
  if (!logic?.FieldMoveParty || !logic[fn]) return null;
  if (!game.settings.get(POKEMON_ASSETS, setting)) return null;
  return logic.FieldMoveParty(token)?.find(logic[fn]) ?? null;
}

/** Cells of the region crossed in a straight line from `entry`, and the landing cell past it. */
function planCrossing(region, token, entry) {
  const { sizeX, sizeY } = canvas.grid;
  const center = token.object?.center ?? canvas.grid.getCenterPoint({ x: token.x, y: token.y });
  const dx = Math.sign(Math.round(entry.x - center.x)) * sizeX;
  const dy = Math.sign(Math.round(entry.y - center.y)) * sizeY;
  if (!dx && !dy) return null;

  const elevation = token.elevation ?? 0;
  const crossed = [];
  let p = { x: entry.x, y: entry.y, elevation };
  while (region.testPoint(p) && crossed.length < MAX_CROSS) {
    crossed.push(p);
    p = { x: p.x + dx, y: p.y + dy, elevation };
  }
  if (!crossed.length || crossed.length >= MAX_CROSS) return null;
  if (!canvas.dimensions.sceneRect.contains(p.x, p.y)) return null;
  return { crossed, landing: p };
}

function playRockClimbDust(crossed) {
  if (typeof globalThis.Sequence !== "function") return;
  let seq = new Sequence({ moduleName: MODULE_ID, softFail: true });
  crossed.forEach((point, i) => {
    seq = seq.effect()
      .atLocation(point)
      .file(`modules/${POKEMON_ASSETS}/img/animations/rock_smash_dppt.json`)
      .size(3, { gridUnits: true })
      .fadeOut(100)
      .delay(i * 100);
  });
  seq.play();
}

/** DGA regionInteractions callback: (region, entry, token) -> handled? */
async function onRegionInteract(region, entry, token) {
  const [key] = fieldMoveBehavior(region);
  if (!key || !token) return false;
  const plan = planCrossing(region, token, entry);
  if (!plan) return false;

  const { fieldMove, used } = MOVES[key];
  const who = partyMember(token, key);
  const UseFieldMove = game.modules.get(POKEMON_ASSETS)?.api?.scripts?.UseFieldMove;
  if (typeof UseFieldMove !== "function") return false;
  // Same prompt flow as Pokémon Assets' TriggerClimb: confirm once, then remember.
  if (!(await UseFieldMove(fieldMove, who, !!who, token[used]))) return true;
  token[used] = true;

  if (key === "rockClimb") playRockClimbDust(plan.crossed);
  const dest = canvas.grid.getTopLeftPoint(plan.landing);
  crossing.add(token.id);
  try {
    await token.update({ x: dest.x, y: dest.y }, {
      animation: key === "rockClimb" ? { duration: plan.crossed.length * 100 } : {},
      movement: {
        [token.id]: {
          constrainOptions: { ignoreWalls: true, ignoreCost: true, ignoreTokens: true, history: false },
        },
      },
    });
  } finally {
    crossing.delete(token.id);
  }
  return true;
}

/* ------------------------------------------------------------------ *
 *  Movement blocking (same mechanism as Pokémon Assets' Surf)
 * ------------------------------------------------------------------ */

function installMovementBlock() {
  const Base = CONFIG.Canvas.layers.tokens.layerClass;
  class TokenLayerFieldMoveRegions extends Base {
    isOccupiedGridSpaceBlocking(gridSpace, token, options = {}) {
      if (crossing.has(token?.document?.id ?? token?.id)) return super.isOccupiedGridSpaceBlocking(gridSpace, token, options);
      const regions = canvas.scene?.regions?.contents ?? [];
      const point = canvas.grid.getCenterPoint(gridSpace);
      const blocked = regions.some((r) => {
        const [, behavior] = fieldMoveBehavior(r);
        return behavior?.system?.blockMovement && r.testPoint(point);
      });
      if (blocked) return true;
      return super.isOccupiedGridSpaceBlocking(gridSpace, token, options);
    }
  }
  CONFIG.Canvas.layers.tokens.layerClass = TokenLayerFieldMoveRegions;
}

/* ------------------------------------------------------------------ *
 *  Remove Pokémon Assets' placement tools
 * ------------------------------------------------------------------ */

function removePlacementTools(controls) {
  const tools = controls?.regions?.tools;
  if (!tools) return;
  delete tools["rocky-wall"];
  delete tools["waterfall"];
}

/* ------------------------------------------------------------------ *
 *  Legacy regions
 * ------------------------------------------------------------------ */

const isLegacyClimbRegion = (region) =>
  region.behaviors.some((b) => b.type === "executeScript" && String(b.system?.source ?? "").includes("TriggerClimb"));

function legacyReport() {
  const lines = [];
  for (const scene of game.scenes) {
    const found = scene.regions.filter(isLegacyClimbRegion);
    if (found.length) lines.push(`  ${scene.name}: ${found.map((r) => r.name).join(", ")}`);
  }
  if (!lines.length) return;
  console.warn(
    `${MODULE_ID} | Legacy Rock Climb / Waterfall regions (locked, created by Pokémon Assets' old tools). ` +
    `They still work. To remove them run game.modules.get("${MODULE_ID}").api.removeLegacyClimbRegions() ` +
    `(viewed scene) or ({ allScenes: true }).\n${lines.join("\n")}`
  );
}

async function removeLegacyClimbRegions({ allScenes = false } = {}) {
  if (!game.user.isGM) return 0;
  const scenes = allScenes ? [...game.scenes] : [canvas.scene].filter(Boolean);
  let removed = 0;
  for (const scene of scenes) {
    const ids = scene.regions.filter(isLegacyClimbRegion).map((r) => r.id);
    if (!ids.length) continue;
    await scene.updateEmbeddedDocuments("Region", ids.map((_id) => ({ _id, locked: false })));
    await scene.deleteEmbeddedDocuments("Region", ids);
    removed += ids.length;
  }
  ui.notifications.info(`Removed ${removed} legacy climb region(s).`);
  return removed;
}

/* ------------------------------------------------------------------ *
 *  Registration
 * ------------------------------------------------------------------ */

Hooks.once("init", () => {
  if (!game.modules.get(DGA)?.active || !game.modules.get(POKEMON_ASSETS)?.active) return;

  for (const [key, { icon }] of Object.entries(MOVES)) {
    const type = typeOf(key);
    CONFIG.RegionBehavior.dataModels[type] = makeBehaviorType();
    CONFIG.RegionBehavior.typeLabels[type] = `TYPES.RegionBehavior.${type}`;
    CONFIG.RegionBehavior.typeIcons[type] = icon;
  }

  const module = game.modules.get(MODULE_ID);
  module.api ??= {};
  module.api.removeLegacyClimbRegions = removeLegacyClimbRegions;

  // After Pokémon Assets' init: it registers its tools and its TokenLayer subclass
  // there, and has already populated DGA's regionInteractions.
  afterModuleInit(POKEMON_ASSETS, () => {
    Hooks.on("getSceneControlButtons", removePlacementTools);
    installMovementBlock();
    const interactions = game.modules.get(DGA)?.api?.regionInteractions;
    if (interactions) {
      interactions["ptre1-field-move-regions"] = {
        eligible: (token) => Object.keys(MOVES).some((k) => !!partyMember(token, k)),
        callback: onRegionInteract,
      };
    }
  });
});

Hooks.once("ready", () => {
  if (game.user.isGM && game.modules.get(POKEMON_ASSETS)?.active) legacyReport();
});
