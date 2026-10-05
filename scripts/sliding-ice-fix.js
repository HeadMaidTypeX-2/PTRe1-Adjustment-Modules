/**
 * Sliding Ice fix — DGA "Sliding Ice" region behavior
 * ---------------------------------------------------
 * DGA's handler (region-behaviors/sliding-ice.mjs) sets token._sliding = true and
 * takes a movement lock, computes the slide, then releases both — with no
 * try/finally. Any exception in between leaves that token frozen on that client
 * until reload. Ways it throws or hangs:
 *   - movement.passed.waypoints empty -> `lastWaypoint.x` TypeError;
 *   - `?? origin` references an undefined variable (ReferenceError);
 *   - token.object null on that client;
 *   - allAnimationsPromise never settling (hangs forever, never unlocks).
 *
 * Core dispatches static behavior events through
 * `system.constructor.events[event.name]` at event time, so swapping the class's
 * static `events` record replaces the handler without touching DGA's files.
 *
 * On V14 the original also crashed Dylan's Animated Tokens (`r is undefined` in
 * _PRIVATE_createAnimationMovementPath) by moving the token mid-way through the
 * triggering step. This version waits for that step, then moves with token.move().
 *
 * Same behavior otherwise: slide cell by cell in the direction of the last step
 * until the token's WHOLE footprint is off the region or it hits a wall, max 80.
 * (DGA tested only the centre point, so a token stopped half on the ice whenever
 * the region's edges weren't exactly on grid lines.)
 * The direction now comes from the last movement segment rather than the whole
 * drag's origin, so a multi-waypoint drag slides the way it entered the ice.
 *
 * Cardinal only on ice: on square grids, any diagonal step that starts or ends on
 * a Sliding Ice cell is cancelled in preUpdateToken (the token stays put), as in
 * the games. Scripted moves that ignore walls (field moves, climbs) and teleports
 * are exempt. This applies to GM drags too: drag across ice in straight lines.
 *
 * No-op unless DGA is active.
 */

import { DGA, afterModuleInit } from "./dylan-modules.js";

const MODULE_ID = "PTRe1-Adjustment-Modules";
const ICE_TYPE = `${DGA}.slidingIce`;
const ANIMATION_TIMEOUT_MS = 5000;
const MAX_STEPS = 80;

function collides(tokenObj, origin, dest) {
  if (typeof tokenObj?.checkCollision === "function") {
    return !!tokenObj.checkCollision(dest, { origin, type: "move", mode: "any" });
  }
  const source = new foundry.canvas.sources.PointMovementSource({ object: tokenObj });
  source.initialize({ x: origin.x, y: origin.y, elevation: origin.elevation });
  const hits = CONFIG.Canvas.polygonBackends.move.testCollision(origin, dest, { type: "move", mode: "any", source });
  return Array.isArray(hits) ? hits.length > 0 : !!hits;
}

function settle(promise) {
  return Promise.race([
    Promise.resolve(promise).catch(() => {}),
    new Promise((r) => setTimeout(r, ANIMATION_TIMEOUT_MS)),
  ]);
}

/**
 * Does any part of the token's footprint (centred on `center`, half-size hx/hy)
 * lie inside the region? Samples a grid of points every half cell, inset 1px so
 * a token sitting exactly against the region's edge doesn't count as inside.
 */
function overlapsRegion(region, center, hx, hy, elevation) {
  const inset = 1;
  const { sizeX, sizeY } = canvas.grid;
  const nx = Math.max(2, Math.round((hx * 2) / (sizeX / 2)));
  const ny = Math.max(2, Math.round((hy * 2) / (sizeY / 2)));
  const x0 = center.x - hx + inset, w = hx * 2 - inset * 2;
  const y0 = center.y - hy + inset, h = hy * 2 - inset * 2;
  for (let i = 0; i <= nx; i++) {
    for (let j = 0; j <= ny; j++) {
      const point = { x: x0 + (w * i) / nx, y: y0 + (h * j) / ny, elevation };
      if (region.testPoint(point, elevation)) return true;
    }
  }
  return false;
}

async function slide(behavior, token, movement) {
  const { region, scene } = behavior;
  const { sizeX, sizeY } = scene.grid;
  const waypoints = movement?.passed?.waypoints ?? [];
  const last = waypoints.at(-1) ?? { x: token.x, y: token.y };
  let prev = waypoints.at(-2);
  if (!prev || (prev.x === last.x && prev.y === last.y)) prev = movement?.origin ?? last;

  const dx = Math.sign(last.x - prev.x) * sizeX;
  const dy = Math.sign(last.y - prev.y) * sizeY;
  if (!dx && !dy) return;

  // Work in cell centres, like DGA (which snapped the top-left to CENTER mode).
  const hx = ((token.width ?? 1) * sizeX) / 2;
  const hy = ((token.height ?? 1) * sizeY) / 2;
  const elevation = last.elevation ?? token.elevation ?? 0;
  const start = { x: last.x + hx, y: last.y + hy, elevation };
  const tokenObj = token.object;

  let end = start;
  for (let n = 1; n < MAX_STEPS; n++) {
    if (n > 1 && !overlapsRegion(region, end, hx, hy, elevation)) break; // fully off the ice
    const next = { x: start.x + dx * n, y: start.y + dy * n, elevation };
    if (collides(tokenObj, start, next)) break;
    end = next;
  }
  if (end === start) return;

  // An explicit waypoint via the movement API, not a bare x/y update: on V14, Dylan's
  // Animated Tokens builds its animation path from the passed waypoints and throws
  // (`lastWaypoint` undefined) when none of them is a finished, non-intermediate one.
  const dest = { x: end.x - hx, y: end.y - hy, elevation };
  const action = last.action ?? token.movementAction;
  if (typeof token.move === "function") {
    await token.move([{ ...dest, ...(action ? { action } : {}) }], { constrainOptions: { ignoreCost: true } });
  } else {
    await token.update({ x: dest.x, y: dest.y });
  }
  await settle(token.object?.allAnimationsPromise);
}

async function onTokenSlide(event) {
  const { scene } = this;
  const { data: { token, movement } = {}, user } = event ?? {};
  if (user?.id !== game.user.id || !token || !scene) return;
  if (token._sliding) return;

  token._sliding = true;
  const unlock = typeof token.lockMovement === "function" ? token.lockMovement() : null;
  try {
    // Cancel only the rest of a multi-waypoint drag; a keyboard step has nothing pending,
    // and stopping it is a suspect in the V14 DAT crash.
    if (movement?.pending?.waypoints?.length) token.stopMovement?.();
    // Let the step onto the ice finish first, as DGA's One-Way Jump does. This handler
    // is called from inside core's processing of that step; moving again before it
    // completes is what DAT choked on.
    await settle(token.object?.allAnimationsPromise);
    if (token.regions && !token.regions.has(this.region)) return;
    await slide(this, token, movement);
  } catch (err) {
    console.error(`${MODULE_ID} | Sliding Ice failed for ${token.name}; token released.`, err);
  } finally {
    token._sliding = false;
    unlock?.();
    token.object?._refreshRotation?.();
  }
}

/* ------------------------------------------------------------------ *
 *  Cardinal-only movement on ice
 * ------------------------------------------------------------------ */

function iceRegions(scene) {
  return scene.regions.filter((r) => r.behaviors.some((b) => b.type === ICE_TYPE && !b.disabled));
}

function isTeleport(waypoint) {
  const action = waypoint?.action;
  return !!action && (action === "displace" || !!CONFIG.Token.movement?.actions?.[action]?.teleport);
}

/** True when the update moves the token diagonally from or onto an ice cell. */
function diagonalOnIce(token, changed, options) {
  if (!("x" in changed) && !("y" in changed)) return false;
  const scene = token.parent;
  if (!scene || scene !== canvas.scene || !canvas.grid?.isSquare) return false;
  const ice = iceRegions(scene);
  if (!ice.length) return false;

  const move = options?.movement?.[token.id];
  if (move?.constrainOptions?.ignoreWalls) return false;
  const waypoints = move?.waypoints?.length
    ? move.waypoints
    : [{ x: changed.x ?? token.x, y: changed.y ?? token.y }];
  if (waypoints.some(isTeleport)) return false;

  const { sizeX, sizeY } = scene.grid;
  const hx = ((token.width ?? 1) * sizeX) / 2;
  const hy = ((token.height ?? 1) * sizeY) / 2;
  const centers = [{ x: token.x, y: token.y }, ...waypoints].map((p) => ({ x: p.x + hx, y: p.y + hy }));
  const path = canvas.grid.getDirectPath(centers);

  const elevation = token.elevation ?? 0;
  const onIce = (offset) => {
    const c = canvas.grid.getCenterPoint(offset);
    return ice.some((r) => overlapsRegion(r, c, sizeX / 2, sizeY / 2, elevation));
  };
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1];
    const b = path[k];
    if (a.i !== b.i && a.j !== b.j && (onIce(a) || onIce(b))) return true;
  }
  return false;
}

Hooks.once("init", () => afterModuleInit(DGA, () => {
  Hooks.on("preUpdateToken", (token, changed, options) => {
    try {
      if (diagonalOnIce(token, changed, options)) return false;
    } catch (err) {
      console.error(`${MODULE_ID} | Ice diagonal check failed; move allowed.`, err);
    }
  });

  const cls = CONFIG.RegionBehavior?.dataModels?.[ICE_TYPE];
  if (!cls) {
    console.warn(`${MODULE_ID} | Sliding Ice fix: '${ICE_TYPE}' is not registered; DGA may have renamed it. Fix not applied.`);
    return;
  }
  const { TOKEN_ENTER, TOKEN_MOVE_WITHIN } = CONST.REGION_EVENTS;
  cls.events = { [TOKEN_ENTER]: onTokenSlide, [TOKEN_MOVE_WITHIN]: onTokenSlide };
  console.log(`${MODULE_ID} | Sliding Ice handler replaced (always releases the token).`);
}));
