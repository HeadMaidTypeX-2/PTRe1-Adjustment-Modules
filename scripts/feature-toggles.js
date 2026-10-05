/**
 * Feature toggles — Module Settings > "Configure Adjustments"
 * ----------------------------------------------------------
 * One world setting per feature (`PTRe1-Adjustment-Modules.feature.<id>`, all
 * default ON, hidden from the normal settings list), edited through a single
 * window that describes each feature.
 *
 * "Live" features check `featureEnabled(id)` at the moment they act, so they
 * switch on/off immediately. "Reload" features patch the system or Foundry once
 * at startup; changing them asks to reload the world.
 *
 * Every gated script imports this file, and it is listed first in esmodules, so
 * the settings are registered before any other `init` handler runs. Reading a
 * setting before registration falls back to the default (on).
 */

export const MODULE_ID = "PTRe1-Adjustment-Modules";

export const FEATURES = [
  // --- PTR system -----------------------------------------------------------
  {
    id: "capabilityRuler", group: "PTR system", live: true,
    title: "Capability-coloured drag ruler",
    description: "Recolours the token drag ruler green / yellow / red using the dragged token's PTR movement capability for the selected Movement Action (Overland, Swim, Sky, Burrow …). Without it, every action uses Foundry's single default speed and the colours never change.",
  },
  {
    id: "consumeItem", group: "PTR system", live: false,
    title: "ConsumeItem rule element",
    description: "Adds a ConsumeItem rule element that decrements an owned item's quantity (deleting it at 0) on a roll, turn/round/combat boundary, or when the item is created or deleted. Turning this off unregisters it: items that still carry a ConsumeItem rule keep it, but PTR skips it (with an 'Unrecognized rule element' console warning) until it's turned back on.",
  },
  {
    id: "evolutionAddons", group: "PTR system", live: false,
    title: "Evolution add-ons",
    description: "Extends PTR's native evolution predicates on level-up: extra roll options (stats and stat comparisons, loyalty, friendship, move types, party species from the trainer's Party folder, held items, user:gm), the source species' predicate as a fallback, a GM view of blocked evolutions with the reason, and consuming evolution items on confirm. Also prints a GM report of legacy evolution data on load.",
  },
  {
    id: "trainerPrereqOr", group: "PTR system", live: false,
    title: "Trainer level-up OR prerequisites",
    description: "Fixes the Trainer Level-Up wizard so prerequisites with alternatives (\"Adept Guile or Stealth\", \"Level 10 or Two of …\") test every option, and reads several known PTR data typos. The window still shows PTR's original prerequisite text.",
  },

  // --- Integrations ---------------------------------------------------------
  {
    id: "aaUserShim", group: "Module integrations", live: false,
    title: "Automated Animations V14 shim",
    description: "Restores ChatMessage#user as an alias of #author, which Foundry V14 removed. Without it Automated Animations' PTU handler throws and animations never play. Does nothing on V13.",
  },
  {
    id: "shopAdapter", group: "Module integrations", live: false, requires: ["stylish-shop"],
    title: "Stylish Shop PTU adapter",
    description: "Registers a PTU adapter with Stylish Shop so the shop reads item descriptions from system.effect and prices from system.cost. Currency is configured separately in the GlitchSmith Library currency dialog (point it at system.money).",
  },
  {
    id: "giftKeywordBridge", group: "Module integrations", live: true, requires: ["stylish-relationship-tracker"],
    title: "Item keywords as gift tags",
    description: "Copies each item's PTU keywords into Stylish Relationship Tracker's gift tags (lowercased, add-only — tags you added by hand are never removed). Syncs on item create/update; the GM backfills existing items on load.",
  },

  // --- Pokémon Assets / DGA -------------------------------------------------
  {
    id: "paintAreaFix", group: "Pokémon Assets / Dylan's General Automations", live: true, requires: ["dylans-general-automations"],
    title: "Canvas-safe cell picker",
    description: "Replaces DGA's 'pick a cell' tool (Door destinations, the old climb tools) with one that never switches layers or uses a measured template, which could freeze the canvas. Left-click picks, right-click or Escape cancels. DGA has adopted this upstream; once that release is installed this is redundant but harmless.",
  },
  {
    id: "slidingIceFix", group: "Pokémon Assets / Dylan's General Automations", live: true, requires: ["dylans-general-automations"],
    title: "Sliding Ice fixes",
    description: "Replaces the Sliding Ice behavior's handler: tokens are always released (never stuck until reload), slides start from the token's grid-snapped position, stop only when the token is completely off the ice (holes included), and stop beside walls and solid tiles instead of half inside them. Turning this off restores DGA's original handler.",
  },
  {
    id: "iceCardinalOnly", group: "Pokémon Assets / Dylan's General Automations", live: true, requires: ["dylans-general-automations"],
    title: "Cardinal-only movement on ice",
    description: "On square grids, blocks any diagonal step that starts or ends on Sliding Ice, as in the games. Scripted moves that ignore walls (field moves) and teleports are exempt; GM drags are not.",
  },
  {
    id: "reinforcements", group: "Pokémon Assets / Dylan's General Automations", live: true, requires: ["dylans-general-automations"],
    title: "Reinforcements Platform: Round End & unlinked spawns",
    description: "Implements the platform's Round End trigger (one reinforcement each round from a chosen round, added to the combat), adds a Reinforcements section to Tile Config, and a per-tile 'Spawn unlinked tokens' option so spawns don't share one sheet. Also applies to the Via Script trigger. Turning this off restores DGA's own spawning; Round End platforms then do nothing.",
  },
  {
    id: "fieldMoveRegions", group: "Pokémon Assets / Dylan's General Automations", live: true, requires: ["dylans-general-automations", "pokemon-assets"],
    title: "Rock Climb & Waterfall region behaviors",
    description: "Replaces Pokémon Assets' 'Place Climbable Rocks' / 'Place Waterfall' region tools with Rock Climb and Waterfall Region Behaviors that work like Surf: tokens can't walk in, and facing the region and pressing Interact crosses it in a straight line if the party knows the move. Turning this off brings the old tools back and makes the behaviors inert (they stay available so existing regions remain valid).",
  },
];

const byId = new Map(FEATURES.map((f) => [f.id, f]));
const settingKey = (id) => `feature.${id}`;

function registerSettings() {
  for (const f of FEATURES) {
    if (game.settings.settings.has(`${MODULE_ID}.${settingKey(f.id)}`)) continue;
    game.settings.register(MODULE_ID, settingKey(f.id), {
      name: f.title,
      scope: "world",
      config: false,
      type: Boolean,
      default: true,
      onChange: () => f.onChange?.(),
    });
  }
}

/** Is the feature switched on? Defaults to true if settings aren't available yet. */
export function featureEnabled(id) {
  try {
    if (!game.settings?.settings?.has(`${MODULE_ID}.${settingKey(id)}`)) registerSettings();
    return game.settings.get(MODULE_ID, settingKey(id)) !== false;
  } catch {
    return true;
  }
}

/** Optional callback run when a live feature is toggled (e.g. re-render controls). */
export function onFeatureChange(id, fn) {
  const f = byId.get(id);
  if (f) f.onChange = fn;
}

/* ------------------------------------------------------------------ *
 *  Window
 * ------------------------------------------------------------------ */

const missing = (f) => (f.requires ?? []).filter((m) => !game.modules.get(m)?.active);
const escape = (s) => foundry.utils.escapeHTML?.(s) ?? String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

class FeatureToggleConfig extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "ptre1-feature-toggles",
    tag: "form",
    classes: ["ptre1-feature-toggles"],
    window: { title: "PTRe1 Adjustments", icon: "fa-solid fa-toggle-on", resizable: true, contentClasses: ["standard-form"] },
    position: { width: 640, height: 720 },
    form: { handler: FeatureToggleConfig.#onSubmit, closeOnSubmit: true },
  };

  async _renderHTML() {
    const groups = Map.groupBy
      ? Map.groupBy(FEATURES, (f) => f.group)
      : FEATURES.reduce((m, f) => m.set(f.group, [...(m.get(f.group) ?? []), f]), new Map());

    const rows = [...groups].map(([group, features]) => `
      <fieldset>
        <legend>${escape(group)}</legend>
        ${features.map((f) => {
          const absent = missing(f);
          const on = featureEnabled(f.id);
          return `
          <div class="ptre1-feature ${absent.length ? "is-unavailable" : ""}">
            <label class="ptre1-feature-head">
              <input type="checkbox" name="${f.id}" ${on ? "checked" : ""}>
              <span class="ptre1-feature-title">${escape(f.title)}</span>
              <span class="ptre1-badge ${f.live ? "live" : "reload"}">${f.live ? "Live" : "Reload"}</span>
            </label>
            <p class="hint">${escape(f.description)}</p>
            ${absent.length ? `<p class="hint ptre1-missing"><i class="fa-solid fa-triangle-exclamation"></i> Inactive: needs ${absent.map(escape).join(", ")}.</p>` : ""}
          </div>`;
        }).join("")}
      </fieldset>`).join("");

    const el = document.createElement("div");
    el.innerHTML = `
      <style>
        .ptre1-feature-toggles .window-content { overflow-y: auto; }
        .ptre1-feature { padding: 0.4rem 0; border-bottom: 1px solid var(--color-border-light-2, rgba(128,128,128,.25)); }
        .ptre1-feature:last-child { border-bottom: none; }
        .ptre1-feature-head { display: flex; align-items: center; gap: 0.5rem; font-weight: bold; }
        .ptre1-feature-title { flex: 1; }
        .ptre1-feature .hint { margin: 0.25rem 0 0 1.75rem; }
        .ptre1-feature.is-unavailable .ptre1-feature-title { opacity: 0.6; }
        .ptre1-missing { color: var(--color-level-warning, #c9822b); }
        .ptre1-badge { font-size: 0.7rem; font-weight: normal; padding: 0 0.4rem; border-radius: 3px; border: 1px solid currentColor; }
        .ptre1-badge.live { color: var(--color-level-success, #3a8f3a); }
        .ptre1-badge.reload { color: var(--color-level-warning, #c9822b); }
      </style>
      <p class="hint">Live features switch on or off immediately. Reload features patch the system at startup, so changing one asks to reload the world. All features are on by default.</p>
      ${rows}
      <footer class="form-footer">
        <button type="submit"><i class="fa-solid fa-floppy-disk"></i> Save Changes</button>
      </footer>`;
    return el;
  }

  _replaceHTML(result, content) {
    content.replaceChildren(...result.childNodes);
  }

  static async #onSubmit(event, form) {
    let needsReload = false;
    for (const f of FEATURES) {
      const input = form.elements.namedItem(f.id);
      if (!input) continue;
      const value = !!input.checked;
      if (value === featureEnabled(f.id)) continue;
      await game.settings.set(MODULE_ID, settingKey(f.id), value);
      if (!f.live) needsReload = true;
    }
    if (!needsReload) return;
    const SettingsConfig = foundry.applications.settings?.SettingsConfig;
    if (typeof SettingsConfig?.reloadConfirm === "function") await SettingsConfig.reloadConfirm({ world: true });
    else ui.notifications.warn("PTRe1 Adjustments: reload the world for your changes to take effect.");
  }
}

Hooks.once("init", () => {
  registerSettings();
  game.settings.registerMenu(MODULE_ID, "featureToggles", {
    name: "Adjustments",
    label: "Configure Adjustments",
    hint: "Turn each fix and feature of this module on or off, with a description of what it does.",
    icon: "fa-solid fa-toggle-on",
    type: FeatureToggleConfig,
    restricted: true,
  });
});
