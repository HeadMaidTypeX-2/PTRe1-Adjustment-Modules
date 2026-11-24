/**
 * Field move cry — Pokémon Assets / DGA add-on
 * --------------------------------------------
 * When a Pokémon uses a field move (Cut, Rock Smash, Strength, Whirlpool,
 * Rock Climb, Waterfall, Headbutt, Surf), Pokémon Assets shows
 * "{name} used <Move>!" in DGA's footer text box. Like talking to Pikachu in
 * Pokémon Yellow, this opens a separate framed window with the Pokémon's
 * portrait, centred in the space above the text box, and plays its cry. The
 * window closes when the text box is dismissed, and only then does the move
 * go ahead, as before. Only the triggering player sees and hears it.
 *
 * Pokémon Assets runs every field move through its internal UseFieldMove,
 * which looks up DGA's `api.scripts.FooterDialogPrompt` on each call. Wrapping
 * that prompt catches all of them, including the ones Pokémon Assets calls
 * directly (Surf, Rock Climb, Waterfall) and this module's own field-move
 * regions. A prompt is only changed when its title and text match a field
 * move's "used" message; everything else passes straight through.
 *
 * - Pokémon: the named Pokémon in the party of the controlled token(s), else
 *   an owned Pokémon with that name. Trainers get no picture or cry.
 * - Picture: the actor's image, else its species image. Token art isn't used,
 *   because Pokémon Assets tokens are sprite sheets.
 * - Cry: Pokémon Assets' `api.logic.ActorCry` (species, form, gender, Mega,
 *   homebrew folder), at DGA's "Cry" volume, for this user only.
 *
 * If no Pokémon is found the message shows as it always did. Live toggle.
 */

import { featureEnabled } from "./feature-toggles.js";

import { DGA, POKEMON_ASSETS, afterModuleInit } from "./dylan-modules.js";

const MODULE_ID = "PTRe1-Adjustment-Modules";

/** Pokémon Assets field move i18n key -> its "can use" logic function (null: none). */
const FIELD_MOVES = {
  RockSmash: "CanUseRockSmash",
  Cut: "CanUseCut",
  Whirlpool: "CanUseWhirlpool",
  Strength: "CanUseStrength",
  RockClimb: "CanUseRockClimb",
  Waterfall: "CanUseWaterfall",
  Headbutt: null,
  Surf: "CanUseSurf",
};

const STYLE_ID = "ptre1-field-move-cry-style";
const BOX_CLASS = "ptre1-fm-portrait";
// Framed like Pokémon Assets' text box: gold edge, grey rim, white inside.
const STYLE = `
  .${BOX_CLASS} {
    position: fixed; z-index: 1000; pointer-events: none;
    left: calc((100vw - 310px) / 2); top: calc((100vh - 200px) / 2);
    width: min(36vh, 320px); aspect-ratio: 1;
    transform: translate(-50%, -50%);
    box-sizing: border-box; padding: 10px;
    background: #66666f; border: 3px solid #e0b030; border-radius: 2px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
    animation: ptre1-fm-portrait-in 350ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
  }
  .${BOX_CLASS}.closing { animation: ptre1-fm-portrait-out 150ms ease-in both; }
  .${BOX_CLASS} .ptre1-fm-portrait-inner {
    width: 100%; height: 100%; box-sizing: border-box;
    display: flex; align-items: center; justify-content: center;
    background: white; border: 2px solid #38383e;
  }
  .${BOX_CLASS} img {
    width: 85%; height: 85%; object-fit: contain; border: none;
    image-rendering: pixelated;
  }
  @keyframes ptre1-fm-portrait-in {
    from { transform: translate(-50%, -50%) scale(0.5); opacity: 0; }
    to   { transform: translate(-50%, -50%) scale(1); opacity: 1; }
  }
  @keyframes ptre1-fm-portrait-out {
    to { transform: translate(-50%, -50%) scale(0.9); opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .${BOX_CLASS}, .${BOX_CLASS}.closing { animation: none; }
  }
`;

const escapeHTML = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "{name} used Strength! {name}'s Strength…" -> regex capturing the name. */
function usedPattern(template) {
  const parts = template.split("{name}").map(escapeRegExp);
  if (parts.length < 2) return null;
  return new RegExp(`^${parts[0]}(?<name>.+?)${parts.slice(1).join("\\k<name>")}$`, "s");
}

/** The field move and Pokémon name in a "used" prompt, or null. */
export function parseUsedPrompt({ title, content } = {}) {
  if (typeof title !== "string" || typeof content !== "string") return null;
  for (const [move, logicFn] of Object.entries(FIELD_MOVES)) {
    const key = `POKEMON-ASSETS.FieldMoves.${move}`;
    if (!game.i18n.has(`${key}.Used`) || title !== game.i18n.localize(`${key}.Title`)) continue;
    const name = usedPattern(game.i18n.localize(`${key}.Used`))?.exec(content.trim())?.groups?.name;
    if (name) return { move, logicFn, name };
  }
  return null;
}

const isPokemon = (actor) => actor?.type === "pokemon";

/** The Pokémon named in the prompt, preferring the controlled token's party and one that knows the move. */
export function findPokemon(name, logicFn) {
  const logic = game.modules.get(POKEMON_ASSETS)?.api?.logic ?? {};
  const party = (canvas?.tokens?.controlled ?? []).flatMap((t) => {
    try {
      return logic.FieldMoveParty?.(t.document) ?? [t.actor];
    } catch {
      return [t.actor];
    }
  });
  const owned = game.actors?.filter?.((a) => a.isOwner) ?? [];
  const candidates = [...new Set([...party, ...owned])].filter((a) => isPokemon(a) && a.name === name);
  const canUse = logicFn && typeof logic[logicFn] === "function" ? logic[logicFn] : null;
  if (canUse) {
    const user = candidates.find((a) => {
      try {
        return !!canUse(a);
      } catch {
        return false;
      }
    });
    if (user) return user;
  }
  return candidates[0] ?? null;
}

const usableImage = (src) => typeof src === "string" && src.length && !src.startsWith("icons/svg/") && src !== CONST.DEFAULT_TOKEN;

export function spriteOf(actor) {
  return [actor?.img, actor?.species?.img].find(usableImage) ?? null;
}

function playCry(actor) {
  const src = game.modules.get(POKEMON_ASSETS)?.api?.logic?.ActorCry?.(actor);
  if (!src) return;
  const volume = game.modules.get(DGA)?.api?.VolumeSettings?.getVolume?.("cry") ?? 0.8;
  if (!(volume > 0)) return;
  if (typeof globalThis.Sequence === "function") {
    new Sequence({ moduleName: MODULE_ID, softFail: true }).sound().file(src).locally(true).volume(volume).play();
  } else {
    foundry.audio.AudioHelper.play({ src, volume, autoplay: true, loop: false }, false);
  }
}

/** Open the portrait window; returns a function that closes it (or null if there's no picture). */
export function openPortrait(actor) {
  const src = spriteOf(actor);
  if (!src) return null;
  const box = document.createElement("div");
  box.className = BOX_CLASS;
  box.setAttribute("aria-hidden", "true");
  box.innerHTML = `<div class="ptre1-fm-portrait-inner"><img src="${escapeHTML(src)}" alt=""></div>`;
  document.body.append(box);

  // Centre over the text box once it has rendered: horizontally on it, vertically
  // in the space above it. Without one, the CSS default (centre of the canvas area) stays.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const footer = [...document.querySelectorAll(".dga.footer-dialog")].at(-1);
    const rect = footer?.getBoundingClientRect?.();
    if (!rect?.width || rect.top <= 0) return;
    box.style.left = `${rect.left + rect.width / 2}px`;
    box.style.top = `${rect.top / 2}px`;
  }));

  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    box.classList.add("closing");
    setTimeout(() => box.remove(), 160);
  };
}

/** For a field move's "used" prompt: play the cry, open the portrait, return its closer. */
export function presentFieldMove(config) {
  const hit = parseUsedPrompt(config);
  if (!hit) return null;
  const actor = findPokemon(hit.name, hit.logicFn);
  if (!actor) return null;
  try {
    playCry(actor);
  } catch (err) {
    console.error(`${MODULE_ID} | Field move cry: could not play ${actor.name}'s cry`, err);
  }
  return openPortrait(actor);
}

// Wraps rather than replaces, so switching the feature off live hands back to DGA's prompt.
function install(module) {
  const scripts = module.api?.scripts;
  const original = scripts?.FooterDialogPrompt;
  if (typeof original !== "function" || original.ptre1CryWrapped) return;
  const wrapped = function (config, ...rest) {
    let close = null;
    if (featureEnabled("fieldMoveCry")) {
      try {
        close = presentFieldMove(config);
      } catch (err) {
        console.error(`${MODULE_ID} | Field move cry failed; showing the plain message.`, err);
      }
    }
    if (!close) return original.call(this, config, ...rest);
    // The portrait stays up exactly as long as the text box.
    try {
      return Promise.resolve(original.call(this, config, ...rest)).finally(close);
    } catch (err) {
      close();
      throw err;
    }
  };
  wrapped.ptre1CryWrapped = true;
  scripts.FooterDialogPrompt = wrapped;
}

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STYLE;
  document.head.append(style);
}

// Pokémon Assets reads DGA's prompt on every call, and also keeps a copy in its
// own api.scripts; wrap both once each module has finished init.
Hooks.once("init", () => {
  if (!game.modules.get(POKEMON_ASSETS)?.active) return;
  injectStyle();
  afterModuleInit(DGA, install);
  afterModuleInit(POKEMON_ASSETS, install);
});
