/**
 * Pokémon cry for everyone — Pokémon Assets / DGA add-on
 * ------------------------------------------------------
 * `api.cry()` makes the selected Pokémon tokens cry, one at a time, the way a field move does
 * (field-move-cry.js): the framed portrait, the cry, and a line in DGA's footer text box. Every
 * connected player gets the same thing on their own screen, at their own Cry volume.
 *
 * Whoever runs it controls the pace: everyone else's text box has no button, and closes when
 * the runner dismisses theirs. A follower's box also closes if the runner disconnects.
 *
 *   game.modules.get("PTRe1-Adjustment-Modules").api.cry()                  // asks for the line
 *   game.modules.get("PTRe1-Adjustment-Modules").api.cry({ text: "{name} roars!" })
 *   ...api.cry({ tokens: [token], text: "" })                               // "" = "{name}!"
 *
 * The runner resolves the picture and cry file and sends only those, so players need no
 * permission on the actor. With the feature off, only the runner sees it. Live toggle.
 */

import { featureEnabled } from "./feature-toggles.js";
import { DGA, POKEMON_ASSETS } from "./dylan-modules.js";
import { openPortrait, playCrySrc, spriteOf } from "./field-move-cry.js";

const MODULE_ID = "PTRe1-Adjustment-Modules";
const SOCKET = `module.${MODULE_ID}`;
// No `type` field: dialogue-trees' socket handler ignores messages without one.
const ACTION_SHOW = "ptre1-pokemon-cry";
const ACTION_CLOSE = "ptre1-pokemon-cry-close";
const FEATURE = "pokemonCry";
const DEFAULT_LINE = "{name}!";
const FOLLOWER_PREFIX = "ptre1-cry-follow-";
// A follower whose runner never closes (and never disconnects) still moves on after this.
const FOLLOWER_TIMEOUT_MS = 5 * 60 * 1000;

const STYLE_ID = "ptre1-pokemon-cry-style";
const STYLE = `[id^="${FOLLOWER_PREFIX}"] footer { display: none !important; }`;

let queue = Promise.resolve();
function enqueue(fn) {
  const run = queue.then(fn).catch((err) => console.error(`${MODULE_ID} | Pokémon cry failed`, err));
  queue = run;
  return run;
}

/** Cries the runner closed before they reached the front of this client's queue. */
const closedEarly = new Set();
/** Cry id -> { from, release } for the follower box on screen. */
const following = new Map();

/**
 * Cry, portrait and text box on this client; resolves when the box closes.
 * The runner closes it with the button; a follower's closes on the runner's word.
 */
async function present({ id, from, name, img, cry, text }, { follower = false } = {}) {
  if (follower && closedEarly.delete(id)) return;
  try {
    playCrySrc(cry);
  } catch (err) {
    console.error(`${MODULE_ID} | Pokémon cry: could not play ${name}'s cry`, err);
  }
  const closePortrait = img ? openPortrait({ img, name }) : null;
  const dialogId = `${FOLLOWER_PREFIX}${id}`;
  let release;
  const released = new Promise((resolve) => (release = resolve));
  let timer;
  if (follower) {
    following.set(id, { from, release });
    timer = setTimeout(release, FOLLOWER_TIMEOUT_MS);
  }
  try {
    const prompt = game.modules.get(DGA)?.api?.scripts?.FooterDialogPrompt;
    const content = `<p>${foundry.utils.escapeHTML(text)}</p>`;
    if (!follower) {
      if (prompt) await prompt({ title: name, content });
      else await new Promise((r) => setTimeout(r, 2500));
    } else {
      const shown = prompt ? prompt({ title: name, content, options: { id: dialogId } }) : released;
      await Promise.race([shown, released]);
    }
  } finally {
    clearTimeout(timer);
    following.delete(id);
    if (follower) foundry.applications.instances?.get(dialogId)?.close();
    closePortrait?.();
  }
}

async function askLine() {
  return foundry.applications.api.DialogV2.prompt({
    window: { title: "Pokémon Cry" },
    content: `<input name="line" type="text" placeholder="${DEFAULT_LINE}" autofocus>`,
    ok: { label: "Cry", callback: (event, button) => button.form.elements.line.value },
    rejectClose: false,
  });
}

/**
 * Make Pokémon cry for every connected player, at the runner's pace.
 * @param {object} [options]
 * @param {Array<Token|TokenDocument|Actor>} [options.tokens] default: the controlled tokens
 * @param {string} [options.text] the line ({name} = the Pokémon's name); omitted = ask
 * @returns {Promise<boolean>} false if nothing was shown
 */
export async function cry({ tokens, text } = {}) {
  const subjects = (tokens ?? canvas?.tokens?.controlled ?? [])
    .map((t) => {
      const actor = t instanceof Actor ? t : t?.actor;
      const name = (t instanceof Actor ? null : (t.document ?? t)?.name) || actor?.name;
      return { actor, name };
    })
    .filter(({ actor }) => actor?.type === "pokemon");
  if (!subjects.length) {
    ui.notifications.warn("Select one or more Pokémon tokens first.");
    return false;
  }
  if (text === undefined) text = await askLine();
  if (text == null) return false; // dialog closed

  const cryOf = game.modules.get(POKEMON_ASSETS)?.api?.logic?.ActorCry;
  for (const { actor, name } of subjects) {
    const payload = {
      action: ACTION_SHOW,
      id: foundry.utils.randomID(),
      from: game.user.id,
      name,
      img: spriteOf(actor),
      cry: cryOf?.(actor) ?? null,
      text: (String(text).trim() || DEFAULT_LINE).replaceAll("{name}", name),
    };
    const broadcast = featureEnabled(FEATURE);
    if (broadcast) game.socket.emit(SOCKET, payload);
    try {
      await enqueue(() => present(payload));
    } finally {
      if (broadcast) game.socket.emit(SOCKET, { action: ACTION_CLOSE, id: payload.id });
    }
  }
  return true;
}

function closeFollower(id) {
  const entry = following.get(id);
  if (entry) entry.release();
  else closedEarly.add(id);
}

function onSocket(msg) {
  if (msg?.action === ACTION_CLOSE) return closeFollower(msg.id);
  if (msg?.action !== ACTION_SHOW || !featureEnabled(FEATURE)) return;
  enqueue(() => present(msg, { follower: true }));
}

Hooks.once("init", () => {
  const module = game.modules.get(MODULE_ID);
  module.api ??= {};
  module.api.cry = cry;
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = STYLE;
    document.head.append(style);
  }
});

Hooks.once("ready", () => {
  game.socket?.on(SOCKET, onSocket);
  // A runner who disconnects can't close their cries; release them.
  Hooks.on("userConnected", (user, connected) => {
    if (connected) return;
    for (const { from, release } of following.values()) if (from === user.id) release();
  });
});
