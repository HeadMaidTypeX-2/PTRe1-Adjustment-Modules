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
 * Same behavior otherwise: slide cell by cell in the direction of the last step
 * until leaving the region (one cell past the edge) or hitting a wall, max 80.
 * The direction now comes from the last movement segment rather than the whole
 * drag's origin, so a multi-waypoint drag slides the way it entered the ice.
 *
 * No-op unless DGA is active.
 */

const MODULE_ID = "PTRe1-Adjustment-Modules";
const DGA = "dylans-general-automations";
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
    if (n > 1 && !region.testPoint(end, elevation)) break; // stepped off the ice
    const next = { x: start.x + dx * n, y: start.y + dy * n, elevation };
    if (collides(tokenObj, start, next)) break;
    end = next;
  }
  if (end === start) return;

  await token.update({ x: end.x - hx, y: end.y - hy });
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
    token.stopMovement?.();
    await slide(this, token, movement);
  } catch (err) {
    console.error(`${MODULE_ID} | Sliding Ice failed for ${token.name}; token released.`, err);
  } finally {
    token._sliding = false;
    unlock?.();
    token.object?._refreshRotation?.();
  }
}

Hooks.once("setup", () => {
  if (!game.modules.get(DGA)?.active) return;
  const cls = CONFIG.RegionBehavior?.dataModels?.[ICE_TYPE];
  if (!cls) {
    console.warn(`${MODULE_ID} | Sliding Ice fix: '${ICE_TYPE}' is not registered; DGA may have renamed it. Fix not applied.`);
    return;
  }
  const { TOKEN_ENTER, TOKEN_MOVE_WITHIN } = CONST.REGION_EVENTS;
  cls.events = { [TOKEN_ENTER]: onTokenSlide, [TOKEN_MOVE_WITHIN]: onTokenSlide };
  console.log(`${MODULE_ID} | Sliding Ice handler replaced (always releases the token).`);
});
