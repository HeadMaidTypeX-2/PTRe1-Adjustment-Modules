/**
 * Pokémon cry for everyone — Pokémon Assets / DGA add-on
 * ------------------------------------------------------
 * `api.cry()` makes the selected Pokémon tokens cry, one at a time, the way a field move does
 * (field-move-cry.js): the framed portrait, the cry, and a line in DGA's footer text box. Every
 * connected player gets the same thing on their own screen, at their own Cry volume, and closes
 * their own text box. Cries arriving while a box is still open wait their turn.
 *
 *   game.modules.get("PTRe1-Adjustment-Modules").api.cry()                  // asks for the line
 *   game.modules.get("PTRe1-Adjustment-Modules").api.cry({ text: "{name} roars!" })
 *   ...api.cry({ tokens: [token], text: "" })                               // "" = "{name}!"
 *
 * The sender resolves the picture and cry file and sends only those, so players need no
 * permission on the actor. With the feature off, only the caller sees it. Live toggle.
 */

import { featureEnabled } from "./feature-toggles.js";
import { DGA, POKEMON_ASSETS } from "./dylan-modules.js";
import { openPortrait, playCrySrc, spriteOf } from "./field-move-cry.js";

const MODULE_ID = "PTRe1-Adjustment-Modules";
const SOCKET = `module.${MODULE_ID}`;
// No `type` field: dialogue-trees' socket handler ignores messages without one.
const ACTION = "ptre1-pokemon-cry";
const FEATURE = "pokemonCry";
const DEFAULT_LINE = "{name}!";

let queue = Promise.resolve();
function enqueue(fn) {
  const run = queue.then(fn).catch((err) => console.error(`${MODULE_ID} | Pokémon cry failed`, err));
  queue = run;
  return run;
}

/** Cry, portrait and text box on this client; resolves when the box is dismissed. */
async function present({ name, img, cry, text }) {
  try {
    playCrySrc(cry);
  } catch (err) {
    console.error(`${MODULE_ID} | Pokémon cry: could not play ${name}'s cry`, err);
  }
  const close = img ? openPortrait({ img, name }) : null;
  try {
    const prompt = game.modules.get(DGA)?.api?.scripts?.FooterDialogPrompt;
    if (prompt) await prompt({ title: name, content: `<p>${foundry.utils.escapeHTML(text)}</p>` });
    else await new Promise((r) => setTimeout(r, 2500));
  } finally {
    close?.();
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
 * Make Pokémon cry for every connected player.
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
      action: ACTION,
      from: game.user.id,
      name,
      img: spriteOf(actor),
      cry: cryOf?.(actor) ?? null,
      text: (String(text).trim() || DEFAULT_LINE).replaceAll("{name}", name),
    };
    if (featureEnabled(FEATURE)) game.socket.emit(SOCKET, payload);
    await enqueue(() => present(payload));
  }
  return true;
}

function onSocket(msg) {
  if (msg?.action !== ACTION || !featureEnabled(FEATURE)) return;
  enqueue(() => present(msg));
}

Hooks.once("init", () => {
  const module = game.modules.get(MODULE_ID);
  module.api ??= {};
  module.api.cry = cry;
});

Hooks.once("ready", () => {
  game.socket?.on(SOCKET, onSocket);
});
