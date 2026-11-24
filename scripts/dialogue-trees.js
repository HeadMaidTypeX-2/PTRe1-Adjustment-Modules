/**
 * Dialogue trees — regions and tiles
 * ----------------------------------
 * A small dialogue script played in the text box (DGA's footer box when DGA is
 * active, Foundry dialogs otherwise), with pages, choices, prerequisite checks
 * against the party, and macros. It can be attached to:
 *
 *   - Regions, as a "Dialogue" Region Behavior (PTRe1-Adjustment-Modules.dialogue):
 *       Start with  Interact (face the region, press DGA's Interact key / Enter)
 *                   or Walking in (moving into the region starts it)
 *       Block entry Tokens can't walk in until the dialogue reaches !enter
 *                   (a move stops at the edge). With Interact, !enter steps the
 *                   token one cell in; with Walking in, it finishes the move.
 *                   Off: tokens walk in freely; the dialogue just plays.
 *   - Tiles, from a Dialogue section in Tile Config: face the tile and press
 *     Interact. Needs DGA.
 *
 * Script:
 *
 *   [start]                       a node; lines before the first [label] belong to "start"
 *   You feel an ominous presence…  text; a blank line or --- starts a new page
 *   ---
 *   Are you sure you are ready?
 *   > Yes -> ready                a choice button: label -> target node
 *   > Show the badge [item:rising-badge] -> ready   only offered if the check passes
 *   > No -> leave
 *
 *   [ready]
 *   !if not item:rising-badge -> weak   jump when the check passes, else carry on
 *   !macro Boss Intro             run a macro (name or UUID)
 *   !enter                        end: success (let the token in; counts for "once")
 *
 *   [leave]
 *   You tremble away from the threshold… for now.
 *   !stay                         end: no success (keep the token out; the default)
 *
 *   -> node                       jump to another node
 *   // comment
 *
 * !done is the same as !enter (reads better on tiles). A node's choices appear
 * with its last page. A node that ends with no choice, jump, !enter or !stay
 * ends without success.
 *
 * Checks use PTR predicate statements, tested against the roll options of the
 * whole party (the token's actor, its trainer, and the trainer's unboxed
 * Pokémon), plus: item:<slug> / <type>:<slug> for every owned item, species:<slug>,
 * self:level:N per Pokémon, trainer:level:N, party:size:N and user:gm.
 * "a, b" means a AND b, "a | b" means a OR b, "not a" negates; JSON predicates
 * ([…] / {…}) work too. e.g. item:rising-badge, self:level:40+, not condition:fainted
 *
 * "Ask again" (both): every time, once per token, or once per actor; "once"
 * counts after a dialogue ends in !enter / !done. Reset remembered ones with
 *   game.modules.get("PTRe1-Adjustment-Modules").api.dialogues.reset()
 * Region dialogues skip GM moves unless "Ask the GM too" is on; pressing
 * Interact always works.
 */

import { MODULE_ID, featureEnabled } from "./feature-toggles.js";

import { DGA, afterModuleInit } from "./dylan-modules.js";

export const TYPE = `${MODULE_ID}.dialogue`;
const FEATURE = "dialogues";
const FLAG = "dialogues"; // remembered "once" passes on tokens / actors
const TILE_FLAG = "dialogue"; // flags[MODULE_ID].dialogue on tiles
const MAX_STEPS = 200;

export const DEFAULT_SCRIPT = `[start]
You feel an ominous presence beyond this threshold...
---
Are you sure you are ready to proceed?
> Yes -> enter
> No -> leave

[enter]
!enter

[leave]
You tremble away from the threshold... for now.
!stay`;

/* ------------------------------------------------------------------ *
 *  Script parsing
 * ------------------------------------------------------------------ */

const NODE_RE = /^\[([^\]]+)\]$/;
const CHOICE_RE = /^>\s*(.+?)\s*(?:\[([^\]]+)\])?\s*->\s*(\S+)$/;
const GOTO_RE = /^->\s*(\S+)$/;
const IF_RE = /^!if\s+(.+?)\s*->\s*(\S+)$/i;
const MACRO_RE = /^!macro\s+(.+)$/i;

/**
 * Script text -> { start, nodes: { label: { steps, choices } }, errors }.
 * Steps: {type: "page", lines} | {type: "goto", target} | {type: "if", predicate, target}
 *        | {type: "macro", ref} | {type: "enter"} | {type: "stay"}
 */
export function parseScript(text) {
  const nodes = {};
  const errors = [];
  let start = null;
  let node = null;
  let page = null;

  const open = (label) => {
    if (nodes[label]) errors.push(`Node [${label}] is defined twice.`);
    node = nodes[label] = { label, steps: [], choices: [] };
    start ??= label;
    page = null;
  };
  const step = (s) => {
    if (!node) open("start");
    if (node.choices.length) errors.push(`[${node.label}]: only choices may follow a choice ("${s.raw}").`);
    page = null;
    node.steps.push(s);
  };

  String(text ?? "").split(/\r?\n/).forEach((rawLine, i) => {
    const line = rawLine.trim();
    const where = `line ${i + 1}`;
    if (line.startsWith("//")) return;
    if (!line || line === "---") {
      page = null;
      return;
    }
    let m;
    if ((m = line.match(NODE_RE))) return open(m[1].trim());
    if (line.startsWith(">")) {
      if (!node) open("start");
      if (!(m = line.match(CHOICE_RE))) return errors.push(`${where}: a choice needs "> Label -> node".`);
      page = null;
      node.choices.push({ label: m[1], predicate: m[2]?.trim() ?? null, target: m[3] });
      return;
    }
    if ((m = line.match(GOTO_RE))) return step({ type: "goto", target: m[1], raw: line });
    if (line.startsWith("!")) {
      if ((m = line.match(IF_RE))) return step({ type: "if", predicate: m[1], target: m[2], raw: line });
      if ((m = line.match(MACRO_RE))) return step({ type: "macro", ref: m[1].trim(), raw: line });
      const cmd = line.toLowerCase();
      if (cmd === "!enter" || cmd === "!done") return step({ type: "enter", raw: line });
      if (cmd === "!stay" || cmd === "!leave" || cmd === "!end") return step({ type: "stay", raw: line });
      return errors.push(`${where}: unknown command "${line}".`);
    }
    // Text
    if (!node) open("start");
    if (node.choices.length) return errors.push(`[${node.label}]: text after a choice ("${line}").`);
    if (!page) {
      page = { type: "page", lines: [] };
      node.steps.push(page);
    }
    page.lines.push(line);
  });

  for (const n of Object.values(nodes)) {
    const targets = [...n.steps.map((s) => s.target).filter(Boolean), ...n.choices.map((c) => c.target)];
    for (const t of targets) if (!nodes[t]) errors.push(`[${n.label}] points to [${t}], which doesn't exist.`);
  }
  if (nodes.start) start = "start";
  return { start, nodes, errors };
}

/* ------------------------------------------------------------------ *
 *  Running
 * ------------------------------------------------------------------ */

/**
 * Walk the dialogue. `io` supplies the side effects (so it can be tested):
 *   page(lines), choose(lines, choices) -> index|null, check(predicate) -> bool, macro(ref, node)
 * Resolves to "enter" or "stay".
 */
export async function runScript(script, io) {
  let label = script.start;
  let steps = 0;
  while (label) {
    const node = script.nodes[label];
    if (!node) return "stay";
    let pending = null; // the last page, held back so choices can be shown with it
    const flush = async () => {
      if (pending) await io.page(pending);
      pending = null;
    };
    let next = null;
    for (const s of node.steps) {
      if (++steps > MAX_STEPS) throw new Error("The dialogue looped more than 200 steps.");
      if (s.type === "page") {
        await flush();
        pending = s.lines;
        continue;
      }
      if (s.type === "if") {
        if (!(await io.check(s.predicate))) continue;
        await flush();
        next = s.target;
        break;
      }
      await flush();
      if (s.type === "goto") {
        next = s.target;
        break;
      }
      if (s.type === "macro") await io.macro(s.ref, label);
      else if (s.type === "enter") return "enter";
      else if (s.type === "stay") return "stay";
    }
    if (next) {
      label = next;
      continue;
    }
    const choices = [];
    for (const c of node.choices) if (!c.predicate || (await io.check(c.predicate))) choices.push(c);
    if (!choices.length) {
      await flush();
      return "stay";
    }
    const picked = await io.choose(pending ?? [], choices);
    if (picked == null || !choices[picked]) return "stay";
    label = choices[picked].target;
  }
  return "stay";
}

/* ------------------------------------------------------------------ *
 *  Prerequisite checks
 * ------------------------------------------------------------------ */

/** "a, not b, c | d" -> PTR predicate array. JSON passes through. */
export function parsePredicate(text) {
  const src = String(text ?? "").trim();
  if (!src) return [];
  if (src.startsWith("[") || src.startsWith("{")) {
    const parsed = JSON.parse(src);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  return src.split(",").map((t) => t.trim()).filter(Boolean).map((term) => {
    const neg = /^not\s+(.+)$/i.exec(term);
    const body = neg ? neg[1].trim() : term;
    const alts = body.split("|").map((a) => a.trim()).filter(Boolean);
    const stmt = alts.length > 1 ? { or: alts } : alts[0];
    return neg ? { not: stmt } : stmt;
  });
}

/** Simple evaluator, used when PTR's PTUPredicate isn't available. */
export function testPredicate(predicate, options) {
  const one = (s) => {
    if (typeof s === "string") {
      const ranged = /^(.*:)(-?\d+)([+-])$/.exec(s);
      if (!ranged) return options.has(s);
      const [, prefix, num, dir] = ranged;
      return [...options].some((o) => {
        if (!o.startsWith(prefix)) return false;
        const n = Number(o.slice(prefix.length));
        return Number.isFinite(n) && (dir === "+" ? n >= Number(num) : n <= Number(num));
      });
    }
    if (s?.not !== undefined) return !one(s.not);
    if (Array.isArray(s?.or)) return s.or.some(one);
    if (Array.isArray(s?.and)) return s.and.every(one);
    if (Array.isArray(s?.nor)) return !s.nor.some(one);
    if (Array.isArray(s?.nand)) return !s.nand.every(one);
    return false;
  };
  return predicate.every(one);
}

let PTUPredicate = null;
async function loadPredicateEngine() {
  if (PTUPredicate || game.system.id !== "ptu") return;
  try {
    ({ PTUPredicate } = await import("/systems/ptu/src/module/system/predication.js"));
  } catch (err) {
    console.warn(`${MODULE_ID} | Dialogue: PTR's predicate engine isn't available; using a simple one.`, err);
  }
}

const slugOf = (doc) => doc?.slug ?? doc?.system?.slug ?? String(doc?.name ?? "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** The token's actor, its trainer, and the trainer's unboxed party. */
export function partyOf(tokenDoc) {
  const actor = tokenDoc?.actor;
  if (!actor) return [];
  const trainerId = actor.type === "pokemon" ? actor.flags?.ptu?.party?.trainer : actor.id;
  const trainer = trainerId ? game.actors.get(trainerId) : null;
  const pokemon = trainer
    ? game.actors.filter((a) => a.flags?.ptu?.party?.trainer === trainer.id && !a.flags?.ptu?.party?.boxed)
    : [];
  return [...new Set([actor, trainer, ...pokemon].filter(Boolean))];
}

/** Every roll option the party has, plus item/species/level/party options. */
export function partyOptions(members) {
  const options = new Set();
  let size = 0;
  for (const a of members) {
    for (const o of a.getRollOptions?.(["all"]) ?? []) options.add(o);
    for (const item of a.items ?? []) {
      const slug = slugOf(item);
      if (!slug) continue;
      options.add(`item:${slug}`);
      options.add(`${item.type}:${slug}`);
    }
    const level = a.system?.level?.current;
    if (a.type === "pokemon") {
      size++;
      const species = slugOf(a.species);
      if (species) options.add(`species:${species}`);
      if (Number.isFinite(level)) options.add(`self:level:${level}`);
    } else if (Number.isFinite(level)) {
      options.add(`trainer:level:${level}`);
    }
  }
  options.add(`party:size:${size}`);
  if (game.user?.isGM) options.add("user:gm");
  return options;
}

function makeChecker(members) {
  const options = partyOptions(members);
  return (text) => {
    try {
      const predicate = parsePredicate(text);
      return PTUPredicate ? PTUPredicate.test(predicate, options) : testPredicate(predicate, options);
    } catch (err) {
      console.error(`${MODULE_ID} | Dialogue: can't read the check "${text}"`, err);
      if (game.user.isGM) ui.notifications.warn(`Dialogue: can't read the check "${text}".`);
      return false;
    }
  };
}

/* ------------------------------------------------------------------ *
 *  Text box
 * ------------------------------------------------------------------ */

async function toHTML(lines) {
  const html = `<p>${lines.join("<br>")}</p>`;
  const TextEditor = foundry.applications?.ux?.TextEditor?.implementation;
  return TextEditor ? TextEditor.enrichHTML(html) : html;
}

function dga() {
  return game.modules.get(DGA)?.active ? game.modules.get(DGA).api : null;
}

async function showPage(title, lines) {
  const content = await toHTML(lines);
  const prompt = dga()?.scripts?.FooterDialogPrompt;
  if (prompt) return prompt({ title, content });
  return foundry.applications.api.DialogV2.prompt({ window: { title }, content, rejectClose: false });
}

async function showChoices(title, lines, choices) {
  const footer = dga()?.FooterDialog;
  const Dialog = footer ?? foundry.applications.api.DialogV2;
  const text = lines.length ? await toHTML(lines) : "";
  const result = await Dialog.wait({
    window: { title },
    content: footer ? `<div class="dialog-content">${text}</div>` : text,
    buttons: choices.map((c, i) => ({ action: `choice${i}`, label: c.label, default: i === 0 })),
    rejectClose: false,
  });
  const index = /^choice(\d+)$/.exec(result ?? "")?.[1];
  return index === undefined ? null : Number(index);
}

/* ------------------------------------------------------------------ *
 *  Macros
 * ------------------------------------------------------------------ */

async function runMacro(ref, scope) {
  const macro = ref.includes(".") ? await fromUuid(ref) : game.macros.getName(ref);
  if (!(macro instanceof foundry.documents.Macro)) {
    console.warn(`${MODULE_ID} | Dialogue: no macro "${ref}".`);
    if (game.user.isGM) ui.notifications.warn(`Dialogue: no macro "${ref}".`);
    return;
  }
  try {
    await macro.execute(scope);
  } catch (err) {
    console.error(`${MODULE_ID} | Dialogue: macro "${ref}" failed`, err);
  }
}

/* ------------------------------------------------------------------ *
 *  Sources: a region behavior or a tile, with one config shape
 * ------------------------------------------------------------------ */

/**
 * { id, kind, name, region?, behavior?, tile?, cfg: { script, title, trigger, block, repeat, askGM } }
 */
function regionSource(region, behavior) {
  return { id: behavior.id, kind: "region", name: behavior.name || region.name, region, behavior, cfg: behavior.system ?? {} };
}

export function tileDialogue(tile) {
  const cfg = tile?.flags?.[MODULE_ID]?.[TILE_FLAG];
  return cfg?.enabled && String(cfg.script ?? "").trim() ? cfg : null;
}

function tileSource(tile, cfg) {
  return { id: tile.id, kind: "tile", name: tile.name || "Tile", tile, cfg: { trigger: "interact", block: false, ...cfg } };
}

/* ------------------------------------------------------------------ *
 *  Remembering "once" passes
 * ------------------------------------------------------------------ */

function holderFor(tokenDoc, source) {
  const mode = source.cfg.repeat ?? "always";
  if (mode === "token") return tokenDoc;
  if (mode === "actor") return tokenDoc.actor;
  return null;
}

function alreadyPassed(tokenDoc, source) {
  return !!holderFor(tokenDoc, source)?.getFlag?.(MODULE_ID, `${FLAG}.${source.id}`);
}

async function rememberPass(tokenDoc, source) {
  const holder = holderFor(tokenDoc, source);
  if (!holder?.isOwner) return;
  try {
    await holder.setFlag(MODULE_ID, `${FLAG}.${source.id}`, true);
  } catch (err) {
    console.warn(`${MODULE_ID} | Dialogue: couldn't remember the pass for ${holder.name}`, err);
  }
}

/** GM: forget remembered passes (all, or for one behavior / tile id) on every actor and token. */
async function reset(id = null) {
  if (!game.user.isGM) return 0;
  let count = 0;
  const clear = async (doc) => {
    const passed = doc.getFlag(MODULE_ID, FLAG);
    if (!passed) return;
    if (id) {
      if (!passed[id]) return;
      await doc.unsetFlag(MODULE_ID, `${FLAG}.${id}`);
    } else {
      await doc.unsetFlag(MODULE_ID, FLAG);
    }
    count++;
  };
  for (const actor of game.actors) await clear(actor);
  for (const scene of game.scenes) for (const token of scene.tokens) await clear(token);
  ui.notifications.info(`Dialogue: cleared ${count} remembered pass(es).`);
  return count;
}

/* ------------------------------------------------------------------ *
 *  Conversation
 * ------------------------------------------------------------------ */

/** Tokens with a dialogue open. */
const busy = new Set();

/** Play the source's dialogue for this token: "enter" or "stay". */
async function converse(tokenDoc, source) {
  const script = parseScript(source.cfg.script ?? "");
  if (script.errors.length) {
    console.warn(`${MODULE_ID} | Dialogue "${source.name}":\n  ${script.errors.join("\n  ")}`);
    if (game.user.isGM) ui.notifications.warn(`Dialogue "${source.name}": ${script.errors[0]}`);
  }
  if (!script.start) return "stay";

  await loadPredicateEngine();
  const members = partyOf(tokenDoc);
  const title = source.cfg.title || source.name;
  const scope = { actor: tokenDoc.actor, token: tokenDoc.object, region: source.region ?? null, behavior: source.behavior ?? null, tile: source.tile ?? null, party: members };
  return runScript(script, {
    page: (lines) => showPage(title, lines),
    choose: (lines, choices) => showChoices(title, lines, choices),
    check: makeChecker(members),
    macro: (ref, node) => runMacro(ref, { ...scope, node }),
  });
}

/* ------------------------------------------------------------------ *
 *  Regions: movement
 * ------------------------------------------------------------------ */

/** source id -> token ids allowed through while their move replays. */
const bypass = new Map();

const WAYPOINT_KEYS = ["x", "y", "elevation", "width", "height", "depth", "shape", "level", "action", "snapped", "explicit", "checkpoint"];
const plainWaypoint = (w) => Object.fromEntries(WAYPOINT_KEYS.filter((k) => w?.[k] !== undefined).map((k) => [k, w[k]]));

/** Index i of the first waypoint pair (i-1 -> i) whose step enters the region, or -1. */
function entryIndex(tokenDoc, region, waypoints) {
  const ENTER = CONST.REGION_MOVEMENT_SEGMENTS.ENTER;
  for (let i = 1; i < waypoints.length; i++) {
    const segments = tokenDoc.segmentizeRegionMovementPath(region, [waypoints[i - 1], waypoints[i]]);
    if (segments.some((s) => s.type === ENTER)) return i;
  }
  return -1;
}

/** "interact" or "walk"; Interact needs DGA's Interact key, so without DGA it's "walk". */
function triggerOf(source) {
  const trigger = source.cfg.trigger ?? "interact";
  return trigger === "interact" && !game.modules.get(DGA)?.active ? "walk" : trigger;
}

/** Does this region dialogue react to this token's movement right now? */
function watchesMovement(tokenDoc, source) {
  if (source.behavior.disabled) return false;
  if (!source.cfg.block && triggerOf(source) !== "walk") return false;
  if (game.user.isGM && !source.cfg.askGM) return false;
  if (bypass.get(source.id)?.has(tokenDoc.id)) return false;
  return !alreadyPassed(tokenDoc, source);
}

function regionSources(regions) {
  const out = [];
  for (const region of regions) for (const behavior of region.behaviors ?? []) if (behavior.type === TYPE) out.push(regionSource(region, behavior));
  return out;
}

function onPreMoveToken(tokenDoc, movement) {
  if (!featureEnabled(FEATURE)) return;
  const sources = regionSources(tokenDoc.parent?.regions?.contents ?? []);
  if (!sources.length) return;
  const waypoints = [movement.origin, ...(movement.passed?.waypoints ?? [])];
  if (waypoints.length < 2) return;

  let first = null;
  try {
    for (const source of sources) {
      if (!watchesMovement(tokenDoc, source)) continue;
      const index = entryIndex(tokenDoc, source.region, waypoints);
      if (index > 0 && (!first || index < first.index)) first = { source, index };
    }
  } catch (err) {
    console.error(`${MODULE_ID} | Dialogue: entry check failed; move allowed.`, err);
    return;
  }
  if (!first) return;
  const { source } = first;

  // Not blocking: the move goes ahead and the dialogue plays as the token enters.
  if (!source.cfg.block) {
    if (busy.has(tokenDoc.id)) return;
    busy.add(tokenDoc.id);
    setTimeout(() => talkOnEntry(tokenDoc, source), 0);
    return;
  }

  if (busy.has(tokenDoc.id)) return false;
  const before = waypoints.slice(1, first.index).map(plainWaypoint);
  const after = [...waypoints.slice(first.index), ...(movement.pending?.waypoints ?? [])].map(plainWaypoint);
  const options = { constrainOptions: movement.constrainOptions, autoRotate: movement.autoRotate };
  const walkIn = triggerOf(source) === "walk";
  // Mark busy now; start once Foundry has finished cancelling this move.
  busy.add(tokenDoc.id);
  setTimeout(() => (walkIn ? talkAtEdge(tokenDoc, source, before, after, options) : stopAtEdge(tokenDoc, source, before, options)), 0);
  return false;
}

async function moveWithBypass(tokenDoc, sourceId, waypoints, options) {
  if (!waypoints.length) return true;
  const ids = bypass.get(sourceId) ?? new Set();
  bypass.set(sourceId, ids.add(tokenDoc.id));
  try {
    return await tokenDoc.move(waypoints, options);
  } finally {
    ids.delete(tokenDoc.id);
    if (!ids.size) bypass.delete(sourceId);
  }
}

/** Block + Interact: a move that would enter just stops at the edge, like Surf water. */
async function stopAtEdge(tokenDoc, source, before, options) {
  try {
    if (before.length) await moveWithBypass(tokenDoc, source.id, before, options);
  } catch (err) {
    console.error(`${MODULE_ID} | Dialogue: couldn't stop at the edge`, err);
  } finally {
    busy.delete(tokenDoc.id);
  }
}

/** Block + Walking in: walk up to the edge, talk, and on !enter finish the move. */
async function talkAtEdge(tokenDoc, source, before, after, options) {
  try {
    if (before.length && !(await moveWithBypass(tokenDoc, source.id, before, options))) return;
    if ((await converse(tokenDoc, source)) !== "enter") return;
    await rememberPass(tokenDoc, source);
    await moveWithBypass(tokenDoc, source.id, after, options);
  } catch (err) {
    console.error(`${MODULE_ID} | Dialogue "${source.name}" failed; the token stays out.`, err);
  } finally {
    busy.delete(tokenDoc.id);
  }
}

/** No block + Walking in: the token is already moving in; just talk. */
async function talkOnEntry(tokenDoc, source) {
  try {
    if ((await converse(tokenDoc, source)) === "enter") await rememberPass(tokenDoc, source);
  } catch (err) {
    console.error(`${MODULE_ID} | Dialogue "${source.name}" failed`, err);
  } finally {
    busy.delete(tokenDoc.id);
  }
}

/* ------------------------------------------------------------------ *
 *  Regions and tiles: DGA's Interact key
 * ------------------------------------------------------------------ */

/** Facing a region and pressing Interact. On !enter (from outside) the token steps into `entry`. */
async function onRegionInteract(region, entry, tokenDoc) {
  if (!featureEnabled(FEATURE) || busy.has(tokenDoc?.id)) return false;
  const inside = !!tokenDoc.testInsideRegion?.(region);
  const source = regionSources([region]).find((s) =>
    !s.behavior.disabled && triggerOf(s) === "interact" && !alreadyPassed(tokenDoc, s)
    // A blocking dialogue is about getting in; from inside there's nothing to cross.
    && !(s.cfg.block && inside));
  if (!source) return false;
  busy.add(tokenDoc.id);
  try {
    if ((await converse(tokenDoc, source)) !== "enter") return true;
    await rememberPass(tokenDoc, source);
    if (!inside) {
      const dest = canvas.grid.getTopLeftPoint(entry);
      await moveWithBypass(tokenDoc, source.id, [{ x: dest.x, y: dest.y }], {});
    }
  } catch (err) {
    console.error(`${MODULE_ID} | Dialogue "${source.name}" failed`, err);
  } finally {
    busy.delete(tokenDoc.id);
  }
  return true;
}

/** Facing a tile with a dialogue and pressing Interact. */
async function onTileInteract(tile, tokenDoc) {
  if (!featureEnabled(FEATURE) || busy.has(tokenDoc?.id)) return false;
  const cfg = tileDialogue(tile);
  if (!cfg) return false;
  const source = tileSource(tile, cfg);
  if (alreadyPassed(tokenDoc, source)) return false;
  busy.add(tokenDoc.id);
  try {
    if ((await converse(tokenDoc, source)) === "enter") await rememberPass(tokenDoc, source);
  } catch (err) {
    console.error(`${MODULE_ID} | Dialogue "${source.name}" failed`, err);
  } finally {
    busy.delete(tokenDoc.id);
  }
  return true;
}

/* ------------------------------------------------------------------ *
 *  Region behavior type
 * ------------------------------------------------------------------ */

const SCRIPT_HINT = "[node] starts a node; text lines are pages (blank line or --- for a new page); \"> Label -> node\" adds a choice (\"> Label [check] -> node\" only if the check passes); \"-> node\" jumps; !if <check> -> node; !macro <name or UUID>; !enter (or !done) ends in success; !stay ends without (the default). Checks use PTR predicates over the party, e.g. item:rising-badge, self:level:40+, not condition:fainted.";
const REPEAT_CHOICES = { always: "Every time", token: "Once per token", actor: "Once per actor" };

function makeBehaviorType() {
  const { fields } = foundry.data;
  class ScriptField extends fields.StringField {
    _toInput(config) {
      config.elementType ??= "textarea";
      return super._toInput(config);
    }
  }
  return class DialogueBehaviorType extends foundry.data.regionBehaviors.RegionBehaviorType {
    static defineSchema() {
      return {
        script: new ScriptField({ initial: DEFAULT_SCRIPT, label: "Dialogue", hint: SCRIPT_HINT }),
        trigger: new fields.StringField({
          initial: "interact",
          choices: { interact: "Interact (face it and press Enter)", walk: "Walking in" },
          label: "Start with",
          hint: "Interact: facing the region and pressing Interact starts the dialogue (needs Dylan's General Automations; without it, walking in is used). Walking in: moving into the region starts it.",
        }),
        block: new fields.BooleanField({
          initial: true,
          label: "Block entry",
          hint: "Tokens can't walk in until the dialogue ends in !enter; a move into the region stops at its edge. With Interact, !enter steps the token one cell in; with Walking in, it finishes the move. Off: tokens walk in freely and the dialogue just plays.",
        }),
        title: new fields.StringField({
          initial: "",
          label: "Speaker",
          hint: "Title of the text box. Defaults to this behavior's or the region's name.",
        }),
        repeat: new fields.StringField({
          initial: "always",
          choices: REPEAT_CHOICES,
          label: "Ask again",
          hint: "Once a dialogue has ended in !enter: play it again every time, never again for that token, or never again for that actor (all its tokens). Reset with game.modules.get('PTRe1-Adjustment-Modules').api.dialogues.reset().",
        }),
        askGM: new fields.BooleanField({
          initial: false,
          label: "Ask the GM too",
          hint: "Off: tokens the GM moves aren't blocked and don't start Walking-in dialogues. Pressing Interact always works.",
        }),
      };
    }
  };
}

/* ------------------------------------------------------------------ *
 *  Tile Config section
 * ------------------------------------------------------------------ */

const escapeHTML = (s) => foundry.utils.escapeHTML?.(String(s ?? "")) ?? String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function onRenderTileConfig(app, html) {
  if (!featureEnabled(FEATURE)) return;
  const root = typeof html?.querySelector === "function" ? html : html?.[0];
  const tile = app.document ?? app.object;
  if (!root || !tile) return;

  root.querySelector(".ptre1-dialogue")?.remove();
  const cfg = tile.flags?.[MODULE_ID]?.[TILE_FLAG] ?? {};
  const base = `flags.${MODULE_ID}.${TILE_FLAG}`;
  const repeat = cfg.repeat ?? "always";
  const options = Object.entries(REPEAT_CHOICES)
    .map(([value, label]) => `<option value="${value}" ${repeat === value ? "selected" : ""}>${label}</option>`).join("");
  const noDGA = game.modules.get(DGA)?.active ? "" : `<p class="hint"><i class="fa-solid fa-triangle-exclamation"></i> Needs Dylan's General Automations (its Interact key starts tile dialogues).</p>`;

  const section = document.createElement("details");
  section.classList.add("ptre1-dialogue");
  if (cfg.enabled) section.open = true;
  section.innerHTML = `
    <summary><i class="fa-solid fa-comments"></i> Dialogue</summary>
    ${noDGA}
    <div class="form-group">
      <label>Enabled</label>
      <div class="form-fields"><input type="checkbox" name="${base}.enabled" ${cfg.enabled ? "checked" : ""}></div>
      <p class="hint">A token facing this tile and pressing Interact (Enter) plays the dialogue.</p>
    </div>
    <div class="form-group">
      <label>Speaker</label>
      <div class="form-fields"><input type="text" name="${base}.title" value="${escapeHTML(cfg.title)}" placeholder="${escapeHTML(tile.name ?? "")}"></div>
    </div>
    <div class="form-group">
      <label>Ask again</label>
      <div class="form-fields"><select name="${base}.repeat">${options}</select></div>
      <p class="hint">Once the dialogue has ended in !enter or !done.</p>
    </div>
    <div class="form-group stacked">
      <label>Dialogue</label>
      <textarea name="${base}.script" class="ptre1-dialogue-script" rows="14">${escapeHTML(cfg.script ?? "")}</textarea>
      <p class="hint">${escapeHTML(SCRIPT_HINT)}</p>
    </div>`;

  const footer = root.querySelector("footer.form-footer, footer");
  if (footer) footer.before(section);
  else (root.querySelector("form") ?? root).append(section);
  section.addEventListener("toggle", () => app.setPosition?.({ height: "auto" }));
  app.setPosition?.({ height: "auto" });
}

/* ------------------------------------------------------------------ *
 *  Registration
 * ------------------------------------------------------------------ */

const STYLE = `
  .region-behavior-config textarea[name="system.script"], .ptre1-dialogue-script {
    min-height: 18em; width: 100%; font-family: var(--font-monospace, monospace); font-size: var(--font-size-13, 13px);
    white-space: pre; tab-size: 2;
  }
  details.ptre1-dialogue { border: 1px solid var(--color-border-light-2, rgba(128,128,128,.4)); border-radius: 4px; padding: 0.25rem 0.5rem; margin: 0.5rem 0; }
  details.ptre1-dialogue > summary { cursor: pointer; font-weight: bold; padding: 0.25rem 0; }
`;

Hooks.once("init", () => {
  CONFIG.RegionBehavior.dataModels[TYPE] = makeBehaviorType();
  CONFIG.RegionBehavior.typeLabels[TYPE] = `TYPES.RegionBehavior.${TYPE}`;
  CONFIG.RegionBehavior.typeIcons[TYPE] = "fa-solid fa-comments";

  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.append(style);

  const module = game.modules.get(MODULE_ID);
  module.api ??= {};
  module.api.dialogues = { reset, parseScript, parsePredicate };

  Hooks.on("preMoveToken", onPreMoveToken);
  Hooks.on("renderTileConfig", onRenderTileConfig);

  // DGA's Interact key: facing a region / tile calls each registered interaction.
  afterModuleInit(DGA, (dga) => {
    const eligible = () => featureEnabled(FEATURE);
    if (dga.api?.regionInteractions) dga.api.regionInteractions["ptre1-dialogue"] = { eligible, callback: onRegionInteract };
    if (dga.api?.tileInteractions) dga.api.tileInteractions["ptre1-dialogue"] = { eligible, callback: onTileInteract };
  });
});
