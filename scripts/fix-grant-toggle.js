// Restores GrantItem equip/enable retraction on ptu 4.4.3.37, where a dropped
// import leaves `GrantItemRuleElement` undefined inside PTUItem#toggleEnableState,
// crashing before it can poke the actor to re-evaluate grants.

Hooks.once("setup", () => {
  if (typeof libWrapper === "undefined" || !game.modules.get("lib-wrapper")?.active) {
    console.error("PTRe1-Adjustments | lib-wrapper inactive — grant-toggle fix NOT applied.");
    return;
  }

  libWrapper.register(
    "PTRe1-Adjustment-Modules",   // ← MUST be this module's id from module.json
    "CONFIG.Item.documentClass.prototype.toggleEnableState",
    async function (wrapped, ...args) {
      try {
        return await wrapped(...args);            // flips state, then throws at the bad line
      } catch (err) {
        const knownGrantBug =
          err instanceof ReferenceError &&
          /GrantItemRuleElement/.test(err?.message ?? "");
        if (!knownGrantBug) throw err;            // never mask anything unrelated
        // Crash landed after the state flip, before the actor poke. Do the poke.
        if (this.actor) await this.actor.update({ "system.timestamp": Date.now() });
      }
    },
    "WRAPPER"
  );

  console.log("PTRe1-Adjustments | GrantItem toggle-retraction fix applied.");
});