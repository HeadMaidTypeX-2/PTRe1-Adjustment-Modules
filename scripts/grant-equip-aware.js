// Equip-aware GrantItem: lets a reevaluating grant retract when its item is unequipped.
// The stock rule sets `ignored = !item.enabled`, and the actor drops ignored rules from
// `actor.rules` — so an unequipped weapon's grant rule vanishes before it can clean up.
// We keep it alive (only for reevaluateOnUpdate grants); test() still fails while disabled,
// so preUpdateActor deletes the grant. Re-equip re-grants via the normal reevaluation path.

const MODULE_ID = "PTRe1-Adjustment-Modules"; // <-- your module.json id

Hooks.once("setup", () => {
  const RE = CONFIG.PTU?.rule?.elements;
  const BaseGrant = RE?.builtin?.GrantItem;
  if (!RE || !BaseGrant) {
    console.error(`${MODULE_ID} | CONFIG.PTU.rule.elements.builtin.GrantItem unreachable — equip-aware grant NOT installed.`);
    return;
  }

  class GrantItemEquipAware extends BaseGrant {
    constructor(source, item, options = {}) {
      super(source, item, options);
      // Survive the "disabled" auto-ignore so preUpdateActor can run and retract.
      if (this.reevaluateOnUpdate && !this.invalid && this.item?.enabled === false) {
        this.ignored = false;
      }
    }
  }

  RE.custom["GrantItem"] = GrantItemEquipAware;
  console.log(`${MODULE_ID} | Equip-aware GrantItem registered.`);
});