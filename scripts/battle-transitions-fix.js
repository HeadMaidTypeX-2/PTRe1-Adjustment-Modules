/**
 * Battle Transitions — V14 auto-trigger (battle-transitions 2.0.14)
 * -----------------------------------------------------------------
 * Battle Transitions caps itself at V13; on V14 its scene "auto-trigger" never
 * fires. It detects activation by wrapping `Scene.prototype.update` and looking
 * for `{active: true}` in the first argument (src/module.ts:41). V14 rewrote
 * `Scene#activate` (new `pullUsers` / `updateData` / `updateOptions` /
 * `viewOptions` signature), so that wrapper no longer sees the activation.
 *
 * 1. Activate (`btActivateTrigger`): a `preUpdateScene` hook sees the change
 *    whichever path makes it. It cancels the activation and runs the scene's
 *    sequence through `BattleTransition.ExecuteSequence`, with a "scenechange"
 *    step first, exactly as the original wrapper did. That step activates the
 *    scene again with `flags.battle-transitions.isTriggered` set, which this hook
 *    lets through.
 *    A stale `isTriggered` (left set when an activation never landed) is ignored
 *    unless a transition is actually running, so it can't block auto-trigger.
 *    While a transition runs, every client that has not switched to the newly
 *    activated scene views it; Battle Transitions waits for that canvasReady.
 *
 * 2. View (`btViewTrigger`): wraps `Scene#view`. Viewing a non-active scene with
 *    auto-trigger on plays its sequence for the viewing user only (Battle
 *    Transitions turns the scene change into a local "viewscene" step).
 *    Viewing the active scene is skipped, because every client views it when
 *    it is activated.
 *
 * Scenes with "bypass transition" set are left alone. Both toggles are Live.
 * Console: game.modules.get("PTRe1-Adjustment-Modules").api.battleTransitions.diagnose()
 */

import { MODULE_ID, featureEnabled } from "./feature-toggles.js";

const BT_ID = "battle-transitions";

/** Number of Battle Transitions sequences running on this client. */
let running = 0;
/** Set from launch until the transition starts, so `view` isn't re-triggered meanwhile. */
let launching = false;

const btActive = () => !!game.modules.get(BT_ID)?.active && typeof globalThis.BattleTransition === "function";
const flagsOf = (scene) => scene?.flags?.[BT_ID] ?? null;

function sequenceOf(scene) {
  const flags = flagsOf(scene);
  const seq = Array.isArray(flags?.sequence) ? flags.sequence : Array.isArray(flags?.steps) ? flags.steps : [];
  return foundry.utils.deepClone(seq);
}

/** Why a scene would not auto-trigger, or null if it would. */
function blockReason(scene, { ignoreTriggered = false } = {}) {
  const flags = flagsOf(scene);
  if (!flags) return "no Battle Transitions configuration";
  if (!sequenceOf(scene).length) return "the transition has no steps";
  if (!(flags.autoTrigger || flags.config?.autoTrigger)) return "auto-trigger is off";
  if (flags.bypassTransition) return "bypass transition is set";
  if (!ignoreTriggered && (flags.isTriggered || flags.autoTriggered)) return "isTriggered flag is set";
  return null;
}

function sceneChangeStep(scene, type = "scenechange") {
  return { id: foundry.utils.randomID(), type, version: type === "viewscene" ? "2.0.0" : "1.1.0", scene: scene.id };
}

async function launch(scene, run) {
  launching = true;
  try {
    await run();
  } catch (err) {
    console.error(`${MODULE_ID} | Battle Transitions: transition for "${scene.name}" failed`, err);
  } finally {
    launching = false;
  }
}

/* ------------------------------------------------------------------ *
 *  Activate
 * ------------------------------------------------------------------ */

function onPreUpdateScene(scene, changes, options, userId) {
  if (changes.active !== true || userId !== game.user.id) return;
  if (!btActive() || !featureEnabled("btActivateTrigger")) return;

  // Battle Transitions' own activation from its scenechange step.
  if (running || launching) return;
  if (blockReason(scene, { ignoreTriggered: true })) return;

  console.log(`${MODULE_ID} | Battle Transitions: activation of "${scene.name}" intercepted; playing its transition.`);
  const sequence = [sceneChangeStep(scene), ...sequenceOf(scene)];
  void launch(scene, () => BattleTransition.ExecuteSequence(sequence));

  delete changes.active;
  if (Object.keys(changes).some((k) => k !== "_id")) return;
  return false;
}

function onUpdateScene(scene, changes) {
  if (changes.active !== true || !running) return;
  if (!featureEnabled("btActivateTrigger")) return;
  if (canvas?.scene?.id === scene.id) return;
  void scene.view();
}

/* ------------------------------------------------------------------ *
 *  View
 * ------------------------------------------------------------------ */

function view(wrapped, ...args) {
  try {
    if (
      game.ready && btActive() && featureEnabled("btViewTrigger")
      && !running && !launching
      && !this.active && canvas?.scene?.id !== this.id
      && !blockReason(this, { ignoreTriggered: true })
    ) {
      console.log(`${MODULE_ID} | Battle Transitions: viewing "${this.name}"; playing its transition locally.`);
      const sequence = [sceneChangeStep(this, "viewscene"), ...sequenceOf(this)];
      return launch(this, () => new BattleTransition().executeSequence(sequence, [game.user.id])).then(() => this);
    }
  } catch (err) {
    console.error(`${MODULE_ID} | Battle Transitions: view trigger failed for "${this.name}"`, err);
  }
  return wrapped(...args);
}

/* ------------------------------------------------------------------ *
 *  Diagnostics
 * ------------------------------------------------------------------ */

function diagnose(scene = canvas?.scene) {
  const scenes = scene ? [scene] : [];
  if (!scene) for (const s of game.scenes) if (flagsOf(s)) scenes.push(s);
  const rows = scenes.map((s) => {
    const flags = flagsOf(s) ?? {};
    return {
      scene: s.name,
      active: s.active,
      steps: sequenceOf(s).length,
      autoTrigger: !!(flags.autoTrigger || flags.config?.autoTrigger),
      bypass: !!flags.bypassTransition,
      isTriggered: !!flags.isTriggered,
      blocked: blockReason(s, { ignoreTriggered: true }) ?? "—",
    };
  });
  console.table(rows);
  console.log(`${MODULE_ID} | Battle Transitions: module active=${btActive()}, running=${running}, activate trigger=${featureEnabled("btActivateTrigger")}, view trigger=${featureEnabled("btViewTrigger")}`);
  return rows;
}

Hooks.once("init", () => {
  const module = game.modules.get(MODULE_ID);
  module.api ??= {};
  module.api.battleTransitions = { diagnose };
});

Hooks.once("setup", () => {
  if (!game.modules.get(BT_ID)?.active) return;

  Hooks.on(`${BT_ID}.transitionStart`, () => { running++; });
  Hooks.on(`${BT_ID}.transitionEnd`, () => { running = Math.max(0, running - 1); });
  Hooks.on("preUpdateScene", onPreUpdateScene);
  Hooks.on("updateScene", onUpdateScene);
  libWrapper.register(MODULE_ID, "Scene.prototype.view", view, "MIXED");
});
