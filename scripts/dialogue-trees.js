/**
 * Dialogue trees — regions and tiles
 * ----------------------------------
 * A small dialogue script played in the text box (DGA's footer box when DGA is
 * active, Foundry dialogs otherwise), with pages, choices, checks against the
 * party, rolls, costs, memory flags and macros. It can be attached to:
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
 * Each text box opens with DGA's interaction sound, as its field moves do.
 * The full syntax is in the README; in short:
 *
 *   [node]                         start a node ("start" is first)
 *   text                           a page; blank line or --- for the next page
 *   {red}…{/} {#3cf}…{/} {b} {i} {u} {big} {small}   styles; {/} closes
 *   {flash1-3} {glow1-3} {rainbow} {wave} {wave2} {shake} {jitter} {pulse} {scroll} {slide} {fade} {type}   effects
 *   {trainer} {pokemon} {lead} {actor} {user} {flag:x} {actor:x} {world:x}   names / values
 *   @Name  /  @Name: text  /  @    speaker shown before the text (@ alone clears it)
 *   > Label -> node                choice;  > Label [check] -> node  only if the check passes
 *   -> node                        jump
 *   !if <check> -> node            jump if the check passes
 *   !macro <name or UUID>
 *   !portrait <actor | image | off>   framed portrait window beside the text box
 *   !sound <file>   !cry [name | lead]
 *   !roll <skill> <dc> [token | best | choose] -> pass | fail    a real PTR skill check
 *   !chance <percent> -> hit | miss
 *   !pay <amount> -> paid | broke     !earn <amount>
 *   !take <item> [qty] -> ok | missing   !give <item or UUID> [qty]
 *   !set [actor: | world:]<name> [value]   !add <name> <n>   !clear <name>
 *   !ask-gm <question> -> yes | no
 *   !enter / !done                 end in success     !stay   end without (default)
 *
 * "-> a | b": go to a on success, b on failure; either may be left out, and
 * then the dialogue carries on with the next line.
 *
 * Checks: PTR predicate statements over the party (the token's actor, its
 * trainer and the trainer's unboxed Pokémon): their roll options, item:<slug>,
 * species:<slug>, self:level:N, trainer:level:N, skill:<skill>:N (rank names
 * work: skill:athletics:adept+), party:size:N, user:gm, memory (flag:x,
 * actor:x, world:x, with :value), and world state (combat:active,
 * combat:round:N, scene:<slug>, time:day / time:night / time:hour:N,
 * season:<slug>). "a, b" = and, "a | b" = or, "not a"; JSON predicates work.
 *
 * Memory: party flags live on the trainer actor, actor flags on the actor
 * talking, world flags in a world setting (players' writes go through the GM's
 * client, so a GM must be connected). All persist across scenes.
 * Console: game.modules.get("PTRe1-Adjustment-Modules").api.dialogues.memory
 *
 * "Ask again": every time, once per token, or once per actor; "once" counts
 * after a dialogue ends in !enter / !done. Reset with api.dialogues.reset().
 */

import { MODULE_ID, featureEnabled } from "./feature-toggles.js";

import { DGA, POKEMON_ASSETS, afterModuleInit } from "./dylan-modules.js";
import { openPortrait, playCry } from "./field-move-cry.js";

export const TYPE = `${MODULE_ID}.dialogue`;
const FEATURE = "dialogues";
const FLAG = "dialogues"; // remembered "once" passes on tokens / actors
const MEMORY = "memory"; // memory flags on actors
const WORLD_MEMORY = "dialogueMemory"; // world setting
const TILE_FLAG = "dialogue"; // flags[MODULE_ID].dialogue on tiles
const SOCKET = `module.${MODULE_ID}`;
const MAX_STEPS = 500;

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

/** "Pokémon Education" -> "pokemon-education" (accents dropped, not turned into dashes). */
const slugify = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const escapeHTML = (s) => foundry.utils?.escapeHTML?.(String(s ?? "")) ?? String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/* ------------------------------------------------------------------ *
 *  Script parsing
 * ------------------------------------------------------------------ */

const NODE_RE = /^\[([^\]]+)\]$/;
const CHOICE_RE = /^>\s*(.+?)\s*(?:\[([^\]]+)\])?\s*->\s*(\S+)$/;
const GOTO_RE = /^->\s*(\S+)$/;
const IF_RE = /^!if\s+(.+?)\s*->\s*(\S+)$/i;
const MACRO_RE = /^!macro\s+(.+)$/i;
const SPEAKER_RE = /^@([^:]*?)\s*(?::\s*(.*))?$/;
const COMMAND_RE = /^!([a-z][a-z-]*)\b\s*(.*?)\s*(?:->\s*([^|\s]*)\s*(?:\|\s*(\S+))?)?$/i;

/** name -> argument check (returns an error message or null). */
const COMMANDS = {
  portrait: (a) => (a.length ? null : "needs an actor, an image or off"),
  sound: (a) => (a.length ? null : "needs a sound file"),
  cry: () => null,
  roll: (a) => (a.length >= 2 && Number.isFinite(Number(a[1])) && (!a[2] || ["token", "best", "choose"].includes(a[2].toLowerCase())) ? null : "needs <skill> <dc> [token | best | choose]"),
  chance: (a) => (a.length === 1 && Number.isFinite(Number(a[0])) ? null : "needs a percentage"),
  pay: (a) => (a.length === 1 && Number(a[0]) >= 0 ? null : "needs an amount"),
  earn: (a) => (a.length === 1 && Number(a[0]) >= 0 ? null : "needs an amount"),
  take: (a) => (a.length ? null : "needs an item"),
  give: (a) => (a.length ? null : "needs an item"),
  set: (a) => (a.length ? null : "needs a flag name"),
  add: (a) => (a.length === 2 && Number.isFinite(Number(a[1])) ? null : "needs <flag> <number>"),
  clear: (a) => (a.length === 1 ? null : "needs a flag name"),
  "ask-gm": () => null,
};

/** Split command arguments on spaces, keeping "quoted text" together. */
function splitArgs(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(/"([^"]*)"|(\S+)/g)) out.push(m[1] ?? m[2]);
  return out;
}

/**
 * Script text -> { start, nodes: { label: { steps, choices } }, errors }.
 * Steps: page {lines} | speaker {name} | goto {target} | if {predicate, target}
 *        | macro {ref} | cmd {name, args, rest, onTrue, onFalse} | enter | stay
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
  const addText = (line) => {
    if (!node) open("start");
    if (node.choices.length) return errors.push(`[${node.label}]: text after a choice ("${line}").`);
    if (!page) {
      page = { type: "page", lines: [] };
      node.steps.push(page);
    }
    page.lines.push(line);
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
    if (line.startsWith("@")) {
      m = line.match(SPEAKER_RE);
      step({ type: "speaker", name: m[1].trim(), raw: line });
      if (m[2]) addText(m[2]);
      return;
    }
    if (line.startsWith("!")) {
      if ((m = line.match(IF_RE))) return step({ type: "if", predicate: m[1], target: m[2], raw: line });
      if ((m = line.match(MACRO_RE))) return step({ type: "macro", ref: m[1].trim(), raw: line });
      const cmd = line.toLowerCase();
      if (cmd === "!enter" || cmd === "!done") return step({ type: "enter", raw: line });
      if (cmd === "!stay" || cmd === "!leave" || cmd === "!end") return step({ type: "stay", raw: line });
      if ((m = line.match(COMMAND_RE)) && COMMANDS[m[1].toLowerCase()]) {
        const name = m[1].toLowerCase();
        const args = splitArgs(m[2]);
        const problem = COMMANDS[name](args);
        if (problem) return errors.push(`${where}: !${name} ${problem}.`);
        return step({ type: "cmd", name, args, rest: m[2], onTrue: m[3] || null, onFalse: m[4] || null, raw: line });
      }
      return errors.push(`${where}: unknown command "${line}".`);
    }
    addText(line);
  });

  // Every jump must land on a node that exists. Name the line that jumps, so it's clear
  // which node is missing (not the one doing the jumping).
  for (const n of Object.values(nodes)) {
    const jumps = [
      ...n.steps.flatMap((s) => [s.target, s.onTrue, s.onFalse].filter(Boolean).map((t) => [t, s.raw])),
      ...n.choices.map((c) => [c.target, `> ${c.label}`]),
    ];
    for (const [t, line] of jumps) {
      if (!nodes[t]) errors.push(`in [${n.label}], "${line}" goes to [${t}], but there's no [${t}] node.`);
    }
  }
  if (nodes.start) start = "start";
  return { start, nodes, errors };
}

/* ------------------------------------------------------------------ *
 *  Running
 * ------------------------------------------------------------------ */

/**
 * Walk the dialogue. `io` supplies the side effects (so it can be tested):
 *   page(lines, speaker), choose(lines, choices, speaker) -> index|null,
 *   check(predicate) -> bool, macro(ref, node), command(step, node) -> bool
 * Resolves to "enter" or "stay".
 */
export async function runScript(script, io) {
  let label = script.start;
  let steps = 0;
  let speaker = null;
  while (label) {
    const node = script.nodes[label];
    if (!node) return "stay";
    let pending = null; // the last page, held back so choices can be shown with it
    const flush = async () => {
      if (pending) await io.page(pending.lines, pending.speaker);
      pending = null;
    };
    let next = null;
    for (const s of node.steps) {
      if (++steps > MAX_STEPS) throw new Error(`The dialogue ran more than ${MAX_STEPS} steps; is it looping?`);
      if (s.type === "page") {
        await flush();
        pending = { lines: s.lines, speaker };
        continue;
      }
      if (s.type === "speaker") {
        speaker = s.name || null;
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
      else if (s.type === "cmd") {
        const ok = !!(await io.command(s, label));
        const target = ok ? s.onTrue : s.onFalse;
        if (target) {
          next = target;
          break;
        }
      } else if (s.type === "enter") return "enter";
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
    const picked = await io.choose(pending?.lines ?? [], choices, pending?.speaker ?? speaker);
    if (picked == null || !choices[picked]) return "stay";
    label = choices[picked].target;
  }
  return "stay";
}

/* ------------------------------------------------------------------ *
 *  Text: styles, placeholders, speaker
 * ------------------------------------------------------------------ */

const COLORS = {
  red: "#d8342c", blue: "#2f6fdb", green: "#2a9a3f", yellow: "#c99a00", orange: "#e0731a", purple: "#8a4fd1",
  pink: "#d9529b", gray: "#7a7a7a", grey: "#7a7a7a", white: "#ffffff", black: "#000000", gold: "#c29b1f",
  teal: "#178f8f", cyan: "#1aa7c4", brown: "#8b5a2b",
};
const STYLE_TAGS = { b: "strong", i: "em", u: "u" };
/** Effects on the whole span. */
export const SPAN_FX = ["big", "small", "shake", "pulse", "fade", "slide", "flash1", "flash2", "flash3", "glow1", "glow2", "glow3"];
/** Effects on each letter (wave, typewriter…): the text inside is split into letters. */
export const LETTER_FX = ["wave", "wave2", "jitter", "rainbow", "type"];

/**
 * "{red}Hi {trainer}{/}" -> HTML. Unknown {…} stays as written; {/} closes the
 * latest effect and anything left open closes at the end.
 */
export function renderMarkup(text, placeholder = () => undefined) {
  const src = String(text);
  const stack = []; // { close, letters }
  let letterDepth = 0;
  let index = 0; // letter number, for staggered timing
  let out = "";

  // Inside a letter effect, wrap each character (entities count as one); words stay
  // together so lines still wrap between words. Tags (<br>, HTML) pass through.
  const letters = (s) => s.replace(/(<[^>]*>)|(\s+)|((?:&[#a-z0-9]+;|[^\s<&]|&)+)/giu, (m, tag, space, word) => {
    if (tag || space) return m;
    const chars = word.match(/&[#a-z0-9]+;|./gsu);
    return `<span class="ptre1-word">${chars.map((c) => `<span class="ptre1-ch" style="--i:${index++}">${c}</span>`).join("")}</span>`;
  });
  const emit = (s) => {
    out += letterDepth ? letters(s) : s;
  };

  const re = /\{([^{}]*)\}/g;
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    emit(src.slice(last, m.index));
    last = re.lastIndex;
    const tag = m[1].trim();
    const low = tag.toLowerCase();
    if (low === "/") {
      const top = stack.pop();
      if (top) {
        out += top.close;
        if (top.letters) letterDepth--;
      }
      continue;
    }
    let open = null;
    let close = "</span>";
    let perLetter = false;
    if (COLORS[low] || /^#[0-9a-f]{3,8}$/i.test(tag)) open = `<span style="color:${COLORS[low] ?? tag}">`;
    else if (STYLE_TAGS[low]) {
      open = `<${STYLE_TAGS[low]}>`;
      close = `</${STYLE_TAGS[low]}>`;
    } else if (SPAN_FX.includes(low)) open = `<span class="ptre1-fx-${low}">`;
    else if (low === "scroll") {
      open = `<span class="ptre1-fx-scroll"><span>`;
      close = "</span></span>";
    } else if (LETTER_FX.includes(low)) {
      open = `<span class="ptre1-fx-${low}">`;
      perLetter = true;
    }
    if (open) {
      if (perLetter && !letterDepth) index = 0;
      out += open;
      stack.push({ close, letters: perLetter });
      if (perLetter) letterDepth++;
      continue;
    }
    const value = placeholder(tag);
    emit(value === undefined || value === null ? m[0] : escapeHTML(value));
  }
  emit(src.slice(last));
  while (stack.length) out += stack.pop().close;
  return out;
}

async function toHTML(lines, speaker, placeholder) {
  const name = speaker ? `<span class="ptre1-dlg-speaker">${renderMarkup(speaker, placeholder)}:</span> ` : "";
  const html = `<p>${name}${renderMarkup(lines.join("<br>"), placeholder)}</p>`;
  const TextEditor = foundry.applications?.ux?.TextEditor?.implementation;
  return TextEditor ? TextEditor.enrichHTML(html) : html;
}

/* ------------------------------------------------------------------ *
 *  Text box
 * ------------------------------------------------------------------ */

function dga() {
  return game.modules.get(DGA)?.active ? game.modules.get(DGA).api : null;
}

/**
 * DGA's interaction blip as every text box opens, as its field moves do.
 * Not awaited: DGA's Interact() waits for the whole sound (plus loading it)
 * before returning, which left about a second of empty screen between pages.
 * The sound now plays while the box appears.
 */
function blip() {
  const interact = dga()?.scripts?.Interact;
  if (typeof interact !== "function") return;
  Promise.resolve()
    .then(() => interact())
    .catch((err) => console.warn(`${MODULE_ID} | Dialogue: interaction sound failed`, err));
}

/** Load DGA's interaction sound up front, so the first blip doesn't wait on a download. */
function preloadBlip() {
  const src = game.modules.get(DGA)?.defaults?.interactionSound;
  if (!src || !game.modules.get(DGA)?.active) return;
  try {
    if (globalThis.Sequencer?.Preloader?.preload) globalThis.Sequencer.Preloader.preload([src]);
    else foundry.audio?.AudioHelper?.preloadSound?.(src);
  } catch (err) {
    console.warn(`${MODULE_ID} | Dialogue: couldn't preload the interaction sound`, err);
  }
}

async function showPage(title, html) {
  blip();
  const prompt = dga()?.scripts?.FooterDialogPrompt;
  if (prompt) return prompt({ title, content: html });
  return foundry.applications.api.DialogV2.prompt({ window: { title }, content: html, rejectClose: false });
}

/** Columns in the choice grid: 2 x N up to four choices, then three wide. */
function choiceColumns(count) {
  return Math.max(1, Math.min(count, count > 4 ? 3 : 2));
}

/**
 * Arrow keys move through the choice grid: Left / Right step through the choices in reading
 * order (wrapping), Up / Down move a whole row. Listens on window in the capture phase, so it
 * runs before DGA's own Up / Down handler (a plain list step) and before Foundry's keybindings
 * (which would pan the canvas), and stops both.
 */
function choiceKeys(getRoot, columns) {
  const onKey = (ev) => {
    const root = getRoot();
    if (!root) return; // not rendered yet
    if (!root.isConnected) return window.removeEventListener("keydown", onKey, true);
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[ev.key];
    if (!step) return;
    const buttons = Array.from(root.querySelectorAll("footer button:not(.header-control)"));
    if (!buttons.length) return;
    let i = buttons.indexOf(document.activeElement);
    if (i < 0) i = 0;
    else if (Math.abs(step) === 1) i = (i + step + buttons.length) % buttons.length;
    else {
      // Up / Down: stay in the same column, wrapping top <-> bottom.
      const rows = Math.ceil(buttons.length / columns);
      const col = i % columns;
      let row = Math.floor(i / columns);
      do row = (row + Math.sign(step) + rows) % rows;
      while (row * columns + col >= buttons.length);
      i = row * columns + col;
    }
    buttons[i].focus({ focusVisible: true });
    ev.preventDefault();
    ev.stopImmediatePropagation();
  };
  window.addEventListener("keydown", onKey, true);
  return () => window.removeEventListener("keydown", onKey, true);
}

/** Buttons with labels; resolves to the index picked, or null when closed. */
async function showButtons(title, html, labels) {
  const footer = dga()?.FooterDialog;
  const Dialog = footer ?? foundry.applications.api.DialogV2;
  const columns = choiceColumns(labels.length);
  let root = null;
  const stopKeys = choiceKeys(() => root, columns);
  blip();
  try {
    const result = await Dialog.wait({
      window: { title },
      classes: ["ptre1-dialogue-box"],
      content: footer ? `<div class="dialog-content">${html}</div>` : html,
      buttons: labels.map((label, i) => ({ action: `choice${i}`, label, default: i === 0 })),
      rejectClose: false,
      // V12 passes the element, V13+ the dialog.
      render: (_event, d) => {
        root = d instanceof HTMLElement ? d : d?.element ?? null;
        root?.style.setProperty("--ptre1-choice-cols", String(columns));
      },
    });
    const index = /^choice(\d+)$/.exec(result ?? "")?.[1];
    return index === undefined ? null : Number(index);
  } finally {
    stopKeys();
  }
}

/* ------------------------------------------------------------------ *
 *  Party and checks
 * ------------------------------------------------------------------ */

/** "a, not b, c | d" -> PTR predicate array. JSON passes through. Rank names become numbers. */
export function parsePredicate(text) {
  const src = String(text ?? "").trim();
  if (!src) return [];
  let predicate;
  if (src.startsWith("[") || src.startsWith("{")) {
    const parsed = JSON.parse(src);
    predicate = Array.isArray(parsed) ? parsed : [parsed];
  } else {
    predicate = src.split(",").map((t) => t.trim()).filter(Boolean).map((term) => {
      const neg = /^not\s+(.+)$/i.exec(term);
      const body = neg ? neg[1].trim() : term;
      const alts = body.split("|").map((a) => a.trim()).filter(Boolean);
      const stmt = alts.length > 1 ? { or: alts } : alts[0];
      return neg ? { not: stmt } : stmt;
    });
  }
  return predicate.map(normalizeStatement);
}

/** Skill ranks, as PTR's prerequisite checker numbers them. */
export const RANKS = { pathetic: 1, untrained: 2, novice: 3, adept: 4, expert: 5, master: 6, virtuoso: 8 };

function normalizeStatement(s) {
  if (typeof s === "string") {
    const m = /^(skill:[^:]+:)([a-z]+)([+-]?)$/i.exec(s);
    return m && RANKS[m[2].toLowerCase()] ? `${m[1].toLowerCase()}${RANKS[m[2].toLowerCase()]}${m[3]}` : s;
  }
  if (Array.isArray(s)) return s.map(normalizeStatement);
  if (s && typeof s === "object") return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, normalizeStatement(v)]));
  return s;
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

const slugOf = (doc) => doc?.slug ?? doc?.system?.slug ?? slugify(doc?.name);

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

const trainerOf = (members, tokenDoc) => members.find((a) => a.type !== "pokemon") ?? tokenDoc?.actor ?? null;
const leadOf = (members, tokenDoc) => (tokenDoc?.actor?.type === "pokemon" ? tokenDoc.actor : members.find((a) => a.type === "pokemon")) ?? null;

/** PTR skill keys -> ids usable in checks and !roll (key and label slug). */
function skillIds(key) {
  const label = game.i18n?.format?.(`SKILL.${key}`);
  return [...new Set([key.toLowerCase(), slugify(label && label !== `SKILL.${key}` ? label : key)])];
}

/** "athletics" / "Pokémon Education" / "pokemonEd" -> PTR skill key, or null. */
export function skillKey(text) {
  const keys = CONFIG.PTU?.data?.skills?.keys ?? [];
  const want = slugify(text);
  return keys.find((k) => skillIds(k).some((id) => slugify(id) === want)) ?? null;
}

const skillRank = (actor, key) => {
  const sk = actor?.system?.skills?.[key];
  const n = sk?.value?.total ?? sk?.value?.value;
  return Number.isFinite(n) ? n : null;
};

/** Every roll option the party has, plus item/species/level/skill/party options. */
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
    for (const key of Object.keys(a.system?.skills ?? {})) {
      const n = skillRank(a, key);
      if (n !== null) for (const id of skillIds(key)) options.add(`skill:${id}:${n}`);
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

/** combat:active, combat:round:N, scene:<slug>, time:day|night, time:hour:N, season:<slug>. */
export function worldOptions() {
  const options = new Set();
  const combat = game.combat;
  if (combat?.started) {
    options.add("combat:active");
    options.add(`combat:round:${combat.round}`);
  }
  const scene = globalThis.canvas?.scene ?? game.scenes?.viewed;
  if (scene?.name) options.add(`scene:${slugify(scene.name)}`);
  let hour = null;
  try {
    const sc = globalThis.SimpleCalendar?.api;
    hour = sc?.currentDateTime?.()?.hour ?? game.time?.components?.hour ?? null;
    const season = sc?.getCurrentSeason?.()?.name;
    if (season) options.add(`season:${slugify(season)}`);
  } catch (err) {
    console.warn(`${MODULE_ID} | Dialogue: couldn't read the time`, err);
  }
  if (Number.isFinite(hour)) {
    options.add(`time:hour:${hour}`);
    options.add(hour >= 6 && hour < 18 ? "time:day" : "time:night");
  }
  return options;
}

/* ------------------------------------------------------------------ *
 *  Memory flags
 * ------------------------------------------------------------------ */

/** "world:bridge-repaired" -> { scope: "world", name: "bridge-repaired" }. Default scope "party". */
export function memoryRef(text) {
  const m = /^(party|actor|world|flag):(.+)$/i.exec(String(text).trim());
  const scope = m ? m[1].toLowerCase() : "party";
  return { scope: scope === "flag" ? "party" : scope, name: slugify(m ? m[2] : text) };
}

/** true / number / slug string. */
export function memoryValue(text) {
  if (text === undefined || text === null || text === "") return true;
  const n = Number(text);
  return Number.isFinite(n) ? n : slugify(text);
}

/** Pending world writes, shown locally until the setting update arrives. */
const worldOverrides = new Map();

function worldMemory() {
  let stored = {};
  try {
    stored = game.settings.get(MODULE_ID, WORLD_MEMORY) ?? {};
  } catch {
    /* not registered */
  }
  const merged = { ...stored };
  for (const [k, v] of worldOverrides) {
    if (v === null) delete merged[k];
    else merged[k] = v;
  }
  return merged;
}

function memoryHolder(scope, ctx) {
  if (scope === "actor") return ctx.tokenDoc?.actor ?? null;
  if (scope === "party") return trainerOf(ctx.members, ctx.tokenDoc);
  return null;
}

function readMemory(scope, name, ctx) {
  if (scope === "world") return worldMemory()[name];
  return memoryHolder(scope, ctx)?.flags?.[MODULE_ID]?.[MEMORY]?.[name];
}

/** flag:x / actor:x / world:x options, plus :value when not just true. */
export function memoryOptions(ctx) {
  const options = new Set();
  const add = (prefix, store) => {
    for (const [k, v] of Object.entries(store ?? {})) {
      if (v === undefined || v === null || v === false) continue;
      options.add(`${prefix}:${k}`);
      if (v !== true) options.add(`${prefix}:${k}:${v}`);
    }
  };
  add("flag", memoryHolder("party", ctx)?.flags?.[MODULE_ID]?.[MEMORY]);
  add("actor", memoryHolder("actor", ctx)?.flags?.[MODULE_ID]?.[MEMORY]);
  add("world", worldMemory());
  return options;
}

/** Write (value) or delete (null) a memory flag. Returns true on success. */
async function writeMemory(scope, name, value, ctx) {
  if (scope === "world") {
    if (game.user.isGM) return setWorldMemory(name, value);
    const reply = await askGMClient({ type: "memory", name, value }, 10_000);
    if (!reply?.ok) {
      ui.notifications.warn("Dialogue: no GM is connected, so the world flag wasn't saved.");
      return false;
    }
    worldOverrides.set(name, value);
    return true;
  }
  const holder = memoryHolder(scope, ctx);
  if (!holder) return false;
  if (!holder.isOwner) {
    console.warn(`${MODULE_ID} | Dialogue: you don't own ${holder.name}; flag "${name}" not saved.`);
    return false;
  }
  if (value === null) await holder.unsetFlag(MODULE_ID, `${MEMORY}.${name}`);
  else await holder.setFlag(MODULE_ID, `${MEMORY}.${name}`, value);
  return true;
}

async function setWorldMemory(name, value) {
  const stored = { ...(game.settings.get(MODULE_ID, WORLD_MEMORY) ?? {}) };
  if (value === null) delete stored[name];
  else stored[name] = value;
  await game.settings.set(MODULE_ID, WORLD_MEMORY, stored);
  return true;
}

/* ------------------------------------------------------------------ *
 *  GM messages (world flags, !ask-gm)
 * ------------------------------------------------------------------ */

const pendingReplies = new Map();

/** Send a request to the active GM's client and wait for its reply (null on timeout / no GM). */
function askGMClient(payload, timeout) {
  if (!game.users?.activeGM) return Promise.resolve(null);
  const id = foundry.utils.randomID();
  return new Promise((resolve) => {
    const timer = timeout ? setTimeout(() => {
      pendingReplies.delete(id);
      resolve(null);
    }, timeout) : null;
    pendingReplies.set(id, (reply) => {
      if (timer) clearTimeout(timer);
      resolve(reply);
    });
    game.socket.emit(SOCKET, { ...payload, id, from: game.user.id });
  });
}

async function onSocket(msg) {
  if (!msg?.type) return;
  if (msg.type === "reply") {
    if (msg.to !== game.user.id) return;
    pendingReplies.get(msg.id)?.(msg);
    pendingReplies.delete(msg.id);
    return;
  }
  if (!game.users.activeGM?.isSelf) return;
  const reply = (data) => game.socket.emit(SOCKET, { type: "reply", id: msg.id, to: msg.from, ...data });
  try {
    if (msg.type === "memory") {
      await setWorldMemory(slugify(msg.name), msg.value ?? null);
      reply({ ok: true });
    } else if (msg.type === "ask") {
      reply({ ok: true, answer: await gmConfirm(msg) });
    }
  } catch (err) {
    console.error(`${MODULE_ID} | Dialogue: GM request failed`, err);
    reply({ ok: false });
  }
}

/** The GM's yes/no window for !ask-gm. */
async function gmConfirm({ from, question, speaker }) {
  const user = game.users.get(from)?.name ?? "A player";
  const who = speaker ? ` (${escapeHTML(speaker)})` : "";
  const content = `<p><strong>${escapeHTML(user)}</strong>${who} asks:</p><p>${escapeHTML(question || "May they continue?")}</p>`;
  const answer = await foundry.applications.api.DialogV2.confirm({
    window: { title: "Dialogue: GM approval", icon: "fa-solid fa-comments" },
    content,
    rejectClose: false,
  });
  return answer === true;
}

/* ------------------------------------------------------------------ *
 *  Commands
 * ------------------------------------------------------------------ */

function resolveActor(text, ctx) {
  const name = String(text ?? "").trim();
  const low = name.toLowerCase();
  if (!name || low === "actor" || low === "self") return ctx.tokenDoc?.actor ?? null;
  if (low === "lead" || low === "pokemon") return leadOf(ctx.members, ctx.tokenDoc);
  if (low === "trainer") return trainerOf(ctx.members, ctx.tokenDoc);
  return ctx.members.find((a) => a.name?.toLowerCase() === low) ?? game.actors.getName?.(name) ?? null;
}

async function resolveActorRef(text, ctx) {
  if (/^(Actor|Compendium|Scene)\./.test(text)) {
    const doc = await fromUuid(text);
    return doc?.documentName === "Token" ? doc.actor : doc;
  }
  return resolveActor(text, ctx);
}

const IMAGE_RE = /\.(png|jpe?g|webp|gif|svg|avif)$/i;
const playSound = (src, volume) => {
  if (typeof globalThis.Sequence === "function") {
    return new Sequence({ moduleName: MODULE_ID, softFail: true }).sound().file(src).locally(true).volume(volume).play();
  }
  return foundry.audio.AudioHelper.play({ src, volume, autoplay: true, loop: false }, false);
};

async function cmdPortrait(args, ctx) {
  ctx.closePortrait?.();
  ctx.closePortrait = null;
  const ref = args.join(" ");
  if (ref.toLowerCase() === "off") return true;
  const subject = IMAGE_RE.test(ref) ? { img: ref, name: "" } : await resolveActorRef(ref, ctx);
  if (!subject) return false;
  ctx.closePortrait = openPortrait(subject);
  return !!ctx.closePortrait;
}

async function cmdCry(args, ctx) {
  const actor = await resolveActorRef(args.join(" "), ctx);
  if (!actor || !game.modules.get(POKEMON_ASSETS)?.active) return false;
  playCry(actor);
  return true;
}

async function cmdRoll([skill, dc, who = "token"], ctx) {
  const key = skillKey(skill);
  if (!key) {
    if (game.user.isGM) ui.notifications.warn(`Dialogue: no skill "${skill}".`);
    return false;
  }
  const target = Number(dc);
  const label = game.i18n.format(`SKILL.${key}`);
  let actor = ctx.tokenDoc?.actor;
  const able = ctx.members.filter((a) => skillRank(a, key) !== null);
  if (who.toLowerCase() === "best") {
    actor = able.reduce((best, a) => (skillRank(a, key) > (skillRank(best, key) ?? -1) ? a : best), able[0] ?? actor);
  } else if (who.toLowerCase() === "choose" && able.length > 1) {
    const html = await toHTML([`Who will make the ${label} check?`], null, ctx.placeholder);
    const index = await showButtons(ctx.title, html, able.map((a) => a.name));
    if (index === null) return false;
    actor = able[index];
  }
  if (!actor) return false;

  let total = null;
  const statistic = actor.attributes?.skills?.[key];
  if (typeof statistic?.roll !== "function" && skillRank(actor, key) === null) return false; // no such skill
  if (typeof statistic?.roll === "function") {
    const token = actor === ctx.tokenDoc?.actor ? ctx.tokenDoc.object : null;
    const result = await statistic.roll({ skipDialog: true, token, overrideLabel: `${label} Check (DC ${target})` });
    total = result?.rolls?.[0]?.total ?? null;
  } else {
    // Not a PTR actor: roll rank d6 and post it.
    const rank = Math.max(1, skillRank(actor, key) ?? 1);
    const roll = await new Roll(`${rank}d6`).evaluate();
    await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: `${label} Check (DC ${target})` });
    total = roll.total;
  }
  return total !== null && total >= target;
}

/** Owned items in the party matching a slug, name or UUID, trainer first. */
function findItems(ref, ctx) {
  const want = slugify(ref);
  const owners = [trainerOf(ctx.members, ctx.tokenDoc), ...ctx.members].filter((a, i, all) => a && all.indexOf(a) === i);
  return owners.flatMap((a) => [...(a.items ?? [])]
    .filter((i) => i.uuid === ref || i._stats?.compendiumSource === ref || i.flags?.core?.sourceId === ref
      || slugOf(i) === want || slugify(i.name) === want));
}

const quantityOf = (item) => Math.max(0, Number(item.system?.quantity ?? 1) || 0);

async function cmdTake(args, ctx) {
  const qtyArg = args.length > 1 && /^\d+$/.test(args.at(-1)) ? Number(args.pop()) : 1;
  const ref = args.join(" ").replace(/^item:/i, "");
  const items = findItems(ref, ctx).sort((a, b) => quantityOf(a) - quantityOf(b));
  if (items.reduce((n, i) => n + quantityOf(i), 0) < qtyArg) return false;
  if (items.some((i) => !i.parent?.isOwner)) return false;
  let left = qtyArg;
  for (const item of items) {
    if (left <= 0) break;
    const q = quantityOf(item);
    const use = Math.min(q, left);
    left -= use;
    if (q - use > 0) await item.update({ "system.quantity": q - use });
    else await item.delete();
  }
  return true;
}

async function itemSource(ref) {
  if (/^(Item|Compendium|Actor)\./.test(ref)) return fromUuid(ref);
  const byName = game.items.getName?.(ref) ?? game.items.find?.((i) => slugify(i.name) === slugify(ref));
  if (byName) return byName;
  for (const pack of game.packs.filter((p) => p.documentName === "Item")) {
    const entry = pack.index.find((e) => slugify(e.name) === slugify(ref));
    if (entry) return pack.getDocument(entry._id);
  }
  return null;
}

async function cmdGive(args, ctx) {
  const qty = args.length > 1 && /^\d+$/.test(args.at(-1)) ? Number(args.pop()) : 1;
  const ref = args.join(" ");
  const trainer = trainerOf(ctx.members, ctx.tokenDoc);
  if (!trainer?.isOwner) return false;
  const source = await itemSource(ref);
  if (!source) {
    if (game.user.isGM) ui.notifications.warn(`Dialogue: no item "${ref}".`);
    return false;
  }
  const existing = [...trainer.items].find((i) => slugify(i.name) === slugify(source.name) && i.type === source.type);
  if (existing && existing.system?.quantity !== undefined) {
    await existing.update({ "system.quantity": quantityOf(existing) + qty });
    return true;
  }
  const data = source.toObject();
  delete data._id;
  if (data.system && "quantity" in data.system) data.system.quantity = qty;
  await trainer.createEmbeddedDocuments("Item", [data]);
  return true;
}

async function cmdMoney(amount, ctx) {
  const trainer = trainerOf(ctx.members, ctx.tokenDoc);
  if (!trainer?.isOwner) return false;
  const money = Number(trainer.system?.money ?? 0);
  if (money + amount < 0) return false;
  await trainer.update({ "system.money": money + amount });
  return true;
}

async function cmdAskGM(rest, ctx) {
  const question = String(rest ?? "").replace(/^"|"$/g, "").trim();
  if (game.user.isGM) return gmConfirm({ from: game.user.id, question, speaker: ctx.tokenDoc?.actor?.name });
  if (!game.users.activeGM) {
    ui.notifications.warn("Dialogue: no GM is connected to answer.");
    return false;
  }
  ui.notifications.info("Waiting for the GM to answer…");
  const reply = await askGMClient({ type: "ask", question, speaker: ctx.tokenDoc?.actor?.name }, 300_000);
  return !!reply?.answer;
}

async function runCommand(step, ctx) {
  const args = [...step.args];
  switch (step.name) {
    case "portrait": return cmdPortrait(args, ctx);
    case "sound": {
      const volume = dga()?.VolumeSettings?.getVolume?.("interact") ?? 0.8;
      playSound(args.join(" "), volume);
      return true;
    }
    case "cry": return cmdCry(args, ctx);
    case "roll": return cmdRoll(args, ctx);
    case "chance": return Math.random() * 100 < Number(args[0]);
    case "pay": return cmdMoney(-Number(args[0]), ctx);
    case "earn": return cmdMoney(Number(args[0]), ctx);
    case "take": return cmdTake(args, ctx);
    case "give": return cmdGive(args, ctx);
    case "set": {
      const { scope, name } = memoryRef(args[0]);
      return writeMemory(scope, name, memoryValue(args.slice(1).join(" ")), ctx);
    }
    case "add": {
      const { scope, name } = memoryRef(args[0]);
      const current = Number(readMemory(scope, name, ctx));
      return writeMemory(scope, name, (Number.isFinite(current) ? current : 0) + Number(args[1]), ctx);
    }
    case "clear": {
      const { scope, name } = memoryRef(args[0]);
      return writeMemory(scope, name, null, ctx);
    }
    case "ask-gm": return cmdAskGM(step.rest, ctx);
  }
  return false;
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

/** GM: forget remembered "once" passes (all, or for one behavior / tile id). */
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
 *  GM memory tools (console)
 * ------------------------------------------------------------------ */

function actorArg(actor) {
  if (!actor) return null;
  if (typeof actor === "string") return game.actors.get(actor) ?? game.actors.getName(actor) ?? null;
  return actor.actor ?? actor;
}

/** The trainer whose party flags an actor uses. */
function partyHolderOf(actor) {
  if (!actor) return null;
  if (actor.type !== "pokemon") return actor;
  return game.actors.get(actor.flags?.ptu?.party?.trainer) ?? actor;
}

const memoryTools = {
  /** All world flags, and party / actor flags of `actor` (name, id or document). */
  list(actor = null) {
    const a = actorArg(actor);
    const out = { world: worldMemory() };
    if (a) {
      const trainer = partyHolderOf(a);
      out.party = { holder: trainer?.name, ...(trainer?.flags?.[MODULE_ID]?.[MEMORY] ?? {}) };
      out.actor = { holder: a.name, ...(a.flags?.[MODULE_ID]?.[MEMORY] ?? {}) };
    }
    console.log(`${MODULE_ID} | Dialogue memory`, out);
    return out;
  },
  /** set("world:bridge-repaired"), set("talked-to-elder", true, "Red"), set("actor:petted", 2, "Growlithe") */
  async set(ref, value = true, actor = null) {
    if (!game.user.isGM) return false;
    const { scope, name } = memoryRef(ref);
    if (scope === "world") return setWorldMemory(name, value);
    const a = actorArg(actor);
    const holder = scope === "party" ? partyHolderOf(a) : a;
    if (!holder) throw new Error("Pass the actor (name, id or document) for party / actor flags.");
    if (value === null) await holder.unsetFlag(MODULE_ID, `${MEMORY}.${name}`);
    else await holder.setFlag(MODULE_ID, `${MEMORY}.${name}`, value);
    return true;
  },
  clear(ref, actor = null) {
    return memoryTools.set(ref, null, actor);
  },
  /** Wipe all memory: "world", or every party / actor flag on every actor ("actors"), or both ("all"). */
  async wipe(what = "all") {
    if (!game.user.isGM) return false;
    if (what === "world" || what === "all") await game.settings.set(MODULE_ID, WORLD_MEMORY, {});
    if (what === "actors" || what === "all") {
      for (const a of game.actors) if (a.flags?.[MODULE_ID]?.[MEMORY]) await a.unsetFlag(MODULE_ID, MEMORY);
    }
    ui.notifications.info(`Dialogue: memory wiped (${what}).`);
    return true;
  },
};

/* ------------------------------------------------------------------ *
 *  Conversation
 * ------------------------------------------------------------------ */

/** Tokens with a dialogue open. */
const busy = new Set();

function placeholderFor(ctx) {
  return (tag) => {
    const low = tag.toLowerCase();
    if (low === "trainer") return trainerOf(ctx.members, ctx.tokenDoc)?.name;
    if (low === "pokemon" || low === "lead") return leadOf(ctx.members, ctx.tokenDoc)?.name;
    if (low === "actor") return ctx.tokenDoc?.actor?.name;
    if (low === "user") return game.user?.name;
    const m = /^(flag|party|actor|world):(.+)$/i.exec(tag);
    if (m) {
      const { scope, name } = memoryRef(tag);
      const v = readMemory(scope, name, ctx);
      return v === undefined || v === null ? "" : String(v);
    }
    return undefined;
  };
}

/** Play the source's dialogue for this token: "enter" or "stay". */
async function converse(tokenDoc, source) {
  const script = parseScript(source.cfg.script ?? "");
  if (script.errors.length) {
    console.warn(`${MODULE_ID} | Dialogue "${source.name}":\n  ${script.errors.join("\n  ")}`);
    if (game.user.isGM) {
      const more = script.errors.length > 1 ? ` (and ${script.errors.length - 1} more problem${script.errors.length > 2 ? "s" : ""}; all are listed in the console, F12)` : "";
      ui.notifications.warn(`Dialogue "${source.name}": ${script.errors[0]}${more}`);
    }
  }
  if (!script.start) return "stay";

  await loadPredicateEngine();
  const members = partyOf(tokenDoc);
  const ctx = { tokenDoc, members, source, title: source.cfg.title || source.name, closePortrait: null };
  ctx.placeholder = placeholderFor(ctx);
  const check = (text) => {
    try {
      const options = new Set([...partyOptions(members), ...memoryOptions(ctx), ...worldOptions()]);
      const predicate = parsePredicate(text);
      return PTUPredicate ? PTUPredicate.test(predicate, options) : testPredicate(predicate, options);
    } catch (err) {
      console.error(`${MODULE_ID} | Dialogue: can't read the check "${text}"`, err);
      if (game.user.isGM) ui.notifications.warn(`Dialogue: can't read the check "${text}".`);
      return false;
    }
  };
  const scope = { actor: tokenDoc.actor, token: tokenDoc.object, region: source.region ?? null, behavior: source.behavior ?? null, tile: source.tile ?? null, party: members };
  try {
    return await runScript(script, {
      page: async (lines, speaker) => showPage(ctx.title, await toHTML(lines, speaker, ctx.placeholder)),
      choose: async (lines, choices, speaker) =>
        showButtons(ctx.title, lines.length ? await toHTML(lines, speaker, ctx.placeholder) : "", choices.map((c) => renderMarkup(c.label, ctx.placeholder))),
      check,
      macro: (ref, node) => runMacro(ref, { ...scope, node }),
      command: async (step, node) => {
        try {
          return await runCommand(step, ctx);
        } catch (err) {
          console.error(`${MODULE_ID} | Dialogue: "${step.raw}" failed in [${node}]`, err);
          return false;
        }
      },
    });
  } finally {
    ctx.closePortrait?.();
  }
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

const SCRIPT_HINT = "[node] starts a node; text lines are pages (blank line or --- for a new page); \"> Label -> node\" adds a choice (\"> Label [check] -> node\" only if the check passes); \"-> node\" jumps; !if <check> -> node. Text: {red}…{/}, {b}, effects such as {wave}, {flash1}, {glow1}, {rainbow}, {shake}, {scroll}, {type}, placeholders such as {trainer}, and @Speaker. Commands: !macro, !portrait, !sound, !cry, !roll <skill> <dc> -> pass | fail, !chance, !pay, !earn, !take, !give, !set / !add / !clear flags, !ask-gm. !enter (or !done) ends in success; !stay ends without (the default). Full list in the module README.";
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
          hint: "Title of the text box. Defaults to this behavior's or the region's name. To show a name in the text itself, start a line with @Name.",
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
  .ptre1-dlg-speaker { font-weight: bold; }

  /* ---- choice box layout ----
     pokemon-assets pins DGA's choice footer to the box's right edge (absolute, top/bottom 0), so
     its height is the box's, which depends on the text, not the choices. Short text + several
     choices wrapped into a second column that ran off the right edge. Here the text and the
     choices sit side by side in normal flow, the choices in a grid (--ptre1-choice-cols wide, set
     by showButtons), and the box (anchored to the bottom of the screen) grows upward to fit. */
  .dga.footer-dialog.ptre1-dialogue-box.dialog-choices .window-content form.dialog-form {
    display: flex; flex-direction: row; flex-wrap: nowrap; align-items: flex-end; gap: 1em;
  }
  .dga.footer-dialog.ptre1-dialogue-box.dialog-choices .window-content form.dialog-form > .dialog-content {
    flex: 1 1 auto; min-width: 0; align-self: stretch; overflow-wrap: anywhere;
  }
  .dga.footer-dialog.ptre1-dialogue-box.dialog-choices footer {
    position: static; flex: 0 1 auto; display: grid;
    grid-template-columns: repeat(var(--ptre1-choice-cols, 2), minmax(0, max-content));
    column-gap: 1.5em; row-gap: 0.25em; align-items: center;
    max-width: 65%; max-height: 60vh; overflow-y: auto; padding: 0 0 0 0.5em;
  }
  /* The focus arrow sits in reserved space, so moving between choices doesn't shift the grid. */
  .dga.footer-dialog.ptre1-dialogue-box.dialog-choices footer > button {
    position: relative; flex: none; height: auto; min-height: calc(1.25 * var(--input-height, 2rem));
    padding: 0 0 0 1.1em; white-space: normal; text-align: left; justify-content: flex-start; line-height: 1.1;
  }
  .dga.footer-dialog.ptre1-dialogue-box.dialog-choices footer > button:focus::before {
    content: "▶"; position: absolute; left: 0; top: 50%; transform: translateY(-50%);
  }

  /* ---- whole-span effects ---- */
  .ptre1-fx-big { font-size: 1.35em; }
  .ptre1-fx-small { font-size: 0.75em; }
  .ptre1-fx-shake { display: inline-block; animation: ptre1-shake 0.25s linear infinite; }
  .ptre1-fx-pulse { display: inline-block; animation: ptre1-pulse 1s ease-in-out infinite; }
  .ptre1-fx-fade { animation: ptre1-fade 0.8s ease-out both; }
  .ptre1-fx-slide { display: inline-block; animation: ptre1-slide 0.45s ease-out both; }
  .ptre1-fx-flash1 { animation: ptre1-flash1 0.6s steps(1) infinite; }
  .ptre1-fx-flash2 { animation: ptre1-flash2 0.6s steps(1) infinite; }
  .ptre1-fx-flash3 { animation: ptre1-flash3 0.6s steps(1) infinite; }
  .ptre1-fx-glow1 { animation: ptre1-glow1 2.4s linear infinite; }
  .ptre1-fx-glow2 { animation: ptre1-glow2 2.4s linear infinite; }
  .ptre1-fx-glow3 { animation: ptre1-glow3 2.4s linear infinite; }
  .ptre1-fx-scroll { display: block; overflow: hidden; white-space: nowrap; }
  .ptre1-fx-scroll > span { display: inline-block; padding-left: 100%; animation: ptre1-scroll 6s linear infinite; }

  /* ---- per-letter effects: each slot (motion / colour / reveal) can be combined ---- */
  .ptre1-word { display: inline-block; white-space: nowrap; }
  /* The reveal slot (typewriter) keeps letter N hidden for N x step, then simply ends: no
     fill-mode holding a final state and no opacity (which runs on the compositor and could
     flicker or leave letters invisible on a busy canvas). Once it ends, the letter is visible. */
  .ptre1-ch {
    display: inline-block; white-space: pre;
    animation-name: var(--fx-m, none), var(--fx-c, none), var(--fx-r, none);
    animation-duration: var(--fx-md, 1s), var(--fx-cd, 1s), calc(var(--i, 0) * var(--fx-rs, 0s));
    animation-timing-function: ease-in-out, linear, linear;
    animation-iteration-count: infinite, infinite, 1;
    animation-fill-mode: none, none, none;
    animation-delay: calc(var(--i, 0) * var(--fx-ms, 0s)), calc(var(--i, 0) * var(--fx-cs, 0s)), 0s;
  }
  .ptre1-fx-wave { --fx-m: ptre1-wave; --fx-md: 1.2s; --fx-ms: -0.1s; }
  .ptre1-fx-wave2 { --fx-m: ptre1-wave2; --fx-md: 1.4s; --fx-ms: -0.1s; }
  .ptre1-fx-jitter { --fx-m: ptre1-jitter; --fx-md: 0.3s; --fx-ms: -0.07s; }
  .ptre1-fx-rainbow { --fx-c: ptre1-rainbow; --fx-cd: 2s; --fx-cs: -0.12s; }
  .ptre1-fx-type { --fx-r: ptre1-type; --fx-rs: 0.04s; }

  @keyframes ptre1-shake {
    0%, 100% { transform: translate(0, 0); } 25% { transform: translate(-1px, 1px); }
    50% { transform: translate(1px, -1px); } 75% { transform: translate(-1px, -1px); }
  }
  @keyframes ptre1-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.12); } }
  /* Looping motion only goes down from the resting position, never up: the text sits flush
     against the top of the box, and anything rising above it gets sliced off by the frame. */
  .ptre1-fx-pulse { transform-origin: 50% 0; }
  @keyframes ptre1-fade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes ptre1-slide { from { transform: translateY(-0.8em); opacity: 0; } to { transform: none; opacity: 1; } }
  @keyframes ptre1-flash1 { 0% { color: #d8342c; } 50% { color: #e0a800; } }
  @keyframes ptre1-flash2 { 0% { color: #1aa7c4; } 50% { color: #2f4fdb; } }
  @keyframes ptre1-flash3 { 0% { color: #2a9a3f; } 50% { color: #7fcf2a; } }
  @keyframes ptre1-glow1 {
    0%, 100% { color: #d8342c; } 25% { color: #e0a800; } 50% { color: #2a9a3f; } 75% { color: #1aa7c4; }
  }
  @keyframes ptre1-glow2 { 0%, 100% { color: #d8342c; } 33% { color: #b03fc9; } 66% { color: #2f4fdb; } }
  @keyframes ptre1-glow3 { 0%, 100% { color: #8a8a8a; } 33% { color: #2a9a3f; } 66% { color: #1aa7c4; } }
  @keyframes ptre1-scroll { from { transform: translateX(0); } to { transform: translateX(-100%); } }
  @keyframes ptre1-wave { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(0.3em); } }
  @keyframes ptre1-wave2 {
    0%, 100% { transform: translate(0, 0); } 25% { transform: translate(0.1em, 0.15em); }
    50% { transform: translate(0, 0.3em); } 75% { transform: translate(-0.1em, 0.15em); }
  }
  @keyframes ptre1-jitter {
    0%, 100% { transform: translate(0, 0.04em); } 25% { transform: translate(0.04em, 0); }
    50% { transform: translate(-0.05em, 0.1em); } 75% { transform: translate(0.03em, 0.06em); }
  }
  @keyframes ptre1-rainbow {
    0%, 100% { color: #d8342c; } 17% { color: #e0731a; } 33% { color: #c99a00; }
    50% { color: #2a9a3f; } 67% { color: #2f6fdb; } 83% { color: #8a4fd1; }
  }
  @keyframes ptre1-type { from, to { visibility: hidden; } }

  @media (prefers-reduced-motion: reduce) {
    .ptre1-ch, .ptre1-fx-shake, .ptre1-fx-pulse, .ptre1-fx-slide, .ptre1-fx-scroll > span { animation: none !important; }
  }
`;

Hooks.once("init", () => {
  CONFIG.RegionBehavior.dataModels[TYPE] = makeBehaviorType();
  CONFIG.RegionBehavior.typeLabels[TYPE] = `TYPES.RegionBehavior.${TYPE}`;
  CONFIG.RegionBehavior.typeIcons[TYPE] = "fa-solid fa-comments";

  game.settings.register(MODULE_ID, WORLD_MEMORY, {
    name: "Dialogue world memory",
    scope: "world",
    config: false,
    type: Object,
    default: {},
    onChange: () => worldOverrides.clear(),
  });

  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.append(style);

  const module = game.modules.get(MODULE_ID);
  module.api ??= {};
  module.api.dialogues = { reset, memory: memoryTools, parseScript, parsePredicate };

  Hooks.on("preMoveToken", onPreMoveToken);
  Hooks.on("renderTileConfig", onRenderTileConfig);

  // DGA's Interact key: facing a region / tile calls each registered interaction.
  afterModuleInit(DGA, (dga) => {
    const eligible = () => featureEnabled(FEATURE);
    if (dga.api?.regionInteractions) dga.api.regionInteractions["ptre1-dialogue"] = { eligible, callback: onRegionInteract };
    if (dga.api?.tileInteractions) dga.api.tileInteractions["ptre1-dialogue"] = { eligible, callback: onTileInteract };
  });
});

Hooks.once("ready", () => {
  game.socket?.on(SOCKET, onSocket);
  if (featureEnabled(FEATURE)) preloadBlip();
});
