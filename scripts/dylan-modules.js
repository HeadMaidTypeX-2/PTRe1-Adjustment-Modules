/**
 * Helpers for patching Dylan's modules (Dylan's General Automations, Dylan's
 * Animated Tokens, Pokémon Assets). Imported by the fix scripts; not an esmodule
 * entry of its own.
 *
 * Each of those modules finishes its own (async) init by calling
 * `Hooks.callAll("<id>.init")` and setting `module.initialized = true`. Running
 * after that is more reliable than guessing with setup/ready. This mirrors the
 * check those modules use on each other.
 */

export const DGA = "dylans-general-automations";
export const DAT = "dylans-animated-tokens";
export const POKEMON_ASSETS = "pokemon-assets";

/** Run `fn` once module `id` has finished initializing. Never runs if it is inactive. */
export function afterModuleInit(id, fn) {
  const module = game.modules.get(id);
  if (!module?.active) return;
  if (module.initialized) fn(module);
  else Hooks.once(`${id}.init`, () => fn(module));
}
