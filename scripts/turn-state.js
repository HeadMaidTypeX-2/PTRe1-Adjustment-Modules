const MODULE_ID = "PTRe1-Adjustment-Modules";

/* ── turn:active → into rollOptions.all (the store rolls actually read) ── */
Hooks.once("setup", () => {
  if (typeof libWrapper === "undefined" || !game.modules.get("lib-wrapper")?.active)
    return console.error(`${MODULE_ID} | lib-wrapper inactive — turn:active NOT installed.`);

  libWrapper.register(MODULE_ID,
    "CONFIG.Actor.documentClass.prototype.prepareData",
    function (wrapped, ...args) {
      const result = wrapped(...args);
      try {
        if (game.combat?.combatant?.actor?.uuid === this.uuid)
          this.flags.ptu.rollOptions.all["turn:active"] = true;
      } catch (e) { /* options not ready */ }
      return result;
    }, "WRAPPER");
  console.log(`${MODULE_ID} | turn:active installed (rollOptions.all).`);
});

// Combat updates don't re-prep actors, so refresh on turn change / combat end.
const reprep = (combat) => { for (const c of (combat ?? game.combat)?.combatants ?? []) c.actor?.reset?.(); };
Hooks.on("ptu.startTurn", () => reprep());
Hooks.on("deleteCombat", (combat) => reprep(combat));

/* ── turn-start / turn-end selectors (GM emits) ── */
async function dispatchTurnEdge(actor, domain) {
  const options = actor.getRollOptions();

  // Reminders — extractReminders IS on globalThis in 4.4.3.37
  for (const r of await globalThis.extractReminders({
    affects: "origin", origin: actor, target: actor, item: null, domains: [domain], options, roll: null,
  })) await ChatMessage.create(r);

  // ApplyEffects — extractApplyEffects is NOT global here, so read the synthetics store directly
  // (mirrors what the native extractApplyEffects does internally).
  const constructs = actor.synthetics?.applyEffects?.[domain]?.origin ?? [];
  if (constructs.length) {
    const fullOptions = [...options, ...actor.getSelfRollOptions("origin")];
    const raw = (await Promise.all(
      constructs.map(d => d({ test: fullOptions, resolvables: {}, roll: 0 }))
    )).flatMap(e => e ?? []);
    const effects = Object.values(
      raw.reduce((acc, e) => { if (e?.slug && !acc[e.slug]) acc[e.slug] = e; return acc; }, {})
    );
    if (effects.length) await actor.createEmbeddedDocuments("Item", effects, { render: false });
  }
}
Hooks.on("ptu.startTurn", (c) => { if (game.users.activeGM?.id === game.user.id && c?.actor) dispatchTurnEdge(c.actor, "turn-start"); });
Hooks.on("ptu.endTurn",   (c) => { if (game.users.activeGM?.id === game.user.id && c?.actor) dispatchTurnEdge(c.actor, "turn-end"); });