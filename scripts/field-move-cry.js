/**
 * Field move cry — Pokémon Assets / DGA add-on
 * --------------------------------------------
 * When a Pokémon uses a field move (Cut, Rock Smash, Strength, Whirlpool,
 * Rock Climb, Waterfall, Headbutt, Surf), Pokémon Assets shows
 * "{name} used <Move>!" in DGA's footer text box. This puts the Pokémon's
 * picture in that same box, next to the text, and plays its cry. The move only
 * goes ahead once the box is dismissed, as before.
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
const STYLE = `
  .ptre1-fm-cry { display: flex; align-items: center; gap: 0.75rem; }
  .ptre1-fm-cry-sprite {
    flex: 0 0 auto; width: 96px; height: 96px; object-fit: contain; border: none;
    filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.45));
    animation: ptre1-fm-cry-pop 450ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
  }
  .ptre1-fm-cry-text { flex: 1 1 auto; }
  @keyframes ptre1-fm-cry-pop {
    0%   { transform: scale(0.4) translateY(12px); opacity: 0; }
    60%  { transform: scale(1.08) translateY(0); opacity: 1; }
    100% { transform: scale(1); }
  }
  @media (prefers-reduced-motion: reduce) { .ptre1-fm-cry-sprite { animation: none; } }
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

/** The prompt config with the Pokémon's picture next to the text. */
function withSprite(config, actor) {
  const src = spriteOf(actor);
  if (!src) return config;
  const content =
    `<div class="ptre1-fm-cry">` +
    `<img class="ptre1-fm-cry-sprite" src="${escapeHTML(src)}" alt="${escapeHTML(actor.name)}">` +
    `<div class="ptre1-fm-cry-text">${config.content}</div>` +
    `</div>`;
  return { ...config, content };
}

/** Returns the (possibly changed) prompt config; plays the cry as a side effect. */
export function decoratePrompt(config) {
  const hit = parseUsedPrompt(config);
  if (!hit) return config;
  const actor = findPokemon(hit.name, hit.logicFn);
  if (!actor) return config;
  try {
    playCry(actor);
  } catch (err) {
    console.error(`${MODULE_ID} | Field move cry: could not play ${actor.name}'s cry`, err);
  }
  return withSprite(config, actor);
}

// Wraps rather than replaces, so switching the feature off live hands back to DGA's prompt.
function install(module) {
  const scripts = module.api?.scripts;
  const original = scripts?.FooterDialogPrompt;
  if (typeof original !== "function" || original.ptre1CryWrapped) return;
  const wrapped = function (config, ...rest) {
    if (featureEnabled("fieldMoveCry")) {
      try {
        config = decoratePrompt(config);
      } catch (err) {
        console.error(`${MODULE_ID} | Field move cry failed; showing the plain message.`, err);
      }
    }
    return original.call(this, config, ...rest);
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
