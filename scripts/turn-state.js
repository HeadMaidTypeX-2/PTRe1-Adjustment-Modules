const MODULE_ID = "PTRe1-Adjustment-Modules";

/* ── ROLL-OPTION LEVER: turn:active ──────────────────────────────────
   Stateless. getRollOptions() gains "turn:active" whenever the actor is
   the current combatant. */
Hooks.once("setup", () => {
  if (typeof libWrapper === "undefined" || !game.modules.get("lib-wrapper")?.active)
    return console.error(`${MODULE_ID} | lib-wrapper inactive — turn:active NOT installed.`);

  libWrapper.register(MODULE_ID,
    "CONFIG.Actor.documentClass.prototype.getRollOptions",
    function (wrapped, domains = []) {
      const options = wrapped(domains);
      if (game.combat?.combatant?.actor?.uuid === this.uuid) options.push("turn:active");
      return options;
    }, "WRAPPER");
  console.log(`${MODULE_ID} | turn:active installed.`);
});

/* ── SELECTOR LEVER: turn-start / turn-end ───────────────────────────
   Dispatches extraction-based elements (Reminder, ApplyEffect) at the
   turn edges. Primary GM only, so messages/effects fire once.*/
async function dispatchTurnEdge(actor, domain) {
  const options = actor.getRollOptions();

  const reminders = await globalThis.extractReminders({
    affects: "origin", origin: actor, target: actor, item: null,
    domains: [domain], options, roll: null,
  });
  for (const r of reminders) await ChatMessage.create(r);

  const effects = Object.values(
    (await globalThis.extractApplyEffects({
      affects: "origin", origin: actor, target: actor, item: null,
      domains: [domain], options, roll: 0,
    })).reduce((acc, e) => { if (!acc[e.slug]) acc[e.slug] = e; return acc; }, {})
  );
  if (effects.length) await actor.createEmbeddedDocuments("Item", effects, { render: false });
}

Hooks.on("ptu.startTurn", async (c) => {
  if (game.users.activeGM?.id === game.user.id && c?.actor) await dispatchTurnEdge(c.actor, "turn-start");
});
Hooks.on("ptu.endTurn", async (c) => {
  if (game.users.activeGM?.id === game.user.id && c?.actor) await dispatchTurnEdge(c.actor, "turn-end");
});