import { RuleElementPTU } from "/systems/ptu/src/module/rules/rule-element/base.js";
import { ResolvableValueField } from "/systems/ptu/src/module/system/schema-data-fields.js";
import { sluggify } from "/systems/ptu/src/util/misc.js";

/**
 * ConsumeItem Rule Element
 *
 * On a configurable trigger, finds a target item in the actor's inventory and decrements its
 * `system.quantity`. When the quantity reaches 0 (or below) the item is removed from the actor.
 *
 * Embedded-document counterpart to InstantChange (which can only touch actor data paths).
 *
 * Target resolution: `uuid` (matched on item.sourceId) -> `targetSlug` -> self.
 *
 * If `confirm` is true, the trigger does NOT consume immediately. Instead it opens a non-blocking
 * confirmation dialog; the decrement/removal runs only when the user confirms. This is the safe
 * choice for attack scrolls: the system applies damage on a LATER "apply damage" click, and that
 * step re-fetches the move from the actor, so the move (and anything that granted it) must still
 * exist at apply-time. The user applies damage first, then confirms removal.
 */
class ConsumeItemRuleElement extends RuleElementPTU {
    /** Guards against re-entrant deletion. */
    static #inFlight = new Set();

    /** @override */
    static defineSchema() {
        const { fields } = foundry.data;
        return {
            ...super.defineSchema(),
            trigger: new fields.StringField({
                required: true,
                nullable: false,
                choices: [
                    "onCreate",
                    "onDelete",
                    "onTurnStart",
                    "onTurnEnd",
                    "onCombatStart",
                    "onCombatEnd",
                    "onRoundStart",
                    "onRoll",
                ],
                initial: "onRoll",
            }),
            selectors: new fields.ArrayField(
                new fields.StringField({ required: true, blank: false, initial: undefined }),
                { required: false, nullable: false, initial: [] }
            ),
            uuid: new fields.StringField({ required: false, nullable: true, blank: false, initial: null }),
            targetSlug: new fields.StringField({ required: false, nullable: true, blank: false, initial: null }),
            quantity: new ResolvableValueField({ required: false, nullable: false, initial: 1 }),
            removeAtZero: new fields.BooleanField({ required: false, nullable: false, initial: true }),
            /** When true, prompt for confirmation (non-blocking) before consuming. */
            confirm: new fields.BooleanField({ required: false, nullable: false, initial: false }),
        };
    }

    /* -------------------------------------------- */
    /* Trigger hooks                                */
    /* -------------------------------------------- */

    async onCreate()      { if (this.trigger === "onCreate")     await this.#consume(); }
    async onDelete()      { if (this.trigger === "onDelete")     await this.#consume(); }
    async onTurnStart()   { if (this.trigger === "onTurnStart")  await this.#consume(); }
    async onTurnEnd()     { if (this.trigger === "onTurnEnd")    await this.#consume(); }
    async onCombatStart() { if (this.trigger === "onCombatStart")await this.#consume(); }
    async onCombatEnd()   { if (this.trigger === "onCombatEnd")  await this.#consume(); }
    async onRoundStart()  { if (this.trigger === "onRoundStart") await this.#consume(); }

    /** @override */
    async afterRollAsync(check, _rolls) {
        if (this.ignored || this.trigger !== "onRoll") return;

        const selectors = this.selectors ?? [];
        if (selectors.length === 0) return;
        if (!selectors.some(s => check.selectors.includes(s))) return;

        await this.#consume(check.targetOptions);
    }

    /* -------------------------------------------- */
    /* Core logic                                   */
    /* -------------------------------------------- */

    #resolveTarget() {
        const uuid = this.uuid ? this.resolveInjectedProperties(this.uuid) : null;
        if (uuid) {
            return (
                this.actor.items.find(i => i.sourceId === uuid) ??
                this.actor.items.find(i => i.flags?.core?.sourceId === uuid) ??
                null
            );
        }

        const slugSource = this.targetSlug ? this.resolveInjectedProperties(this.targetSlug) : null;
        if (slugSource) {
            const slug = sluggify(slugSource);
            return this.actor.items.find(i => i.slug === slug) ?? null;
        }

        return this.item ?? null;
    }

    /**
     * Entry point: predicate-test, resolve the target, then either prompt or apply directly.
     * @param {Set<string>|string[]} [rollOptions]
     */
    async #consume(rollOptions) {
        if (this.ignored) return;

        const options = rollOptions
            ? Array.from(rollOptions)
            : Array.from(new Set(this.actor.getRollOptions()));
        if (!this.test(options)) return;

        const target = this.#resolveTarget();
        if (!target?.id || !this.actor.items.has(target.id)) return;

        if (this.confirm) {
            // Fire-and-forget: do NOT await, so the roll/damage pipeline isn't blocked on user input.
            this.#promptConfirm(target.id);
            return;
        }

        await this.#applyConsume(target.id);
    }

    /**
     * Open a non-blocking confirmation dialog; on confirm, run the consume.
     * @param {string} targetId
     */
    async #promptConfirm(targetId) {
        const target = this.actor.items.get(targetId);
        if (!target) return;
        if (!this.actor.isOwner) return; // only prompt on a client that owns the actor

        const title = this.label && this.label !== this.item?.name ? this.label : "Consume Item";
        const grantNote = this.removeAtZero ? " (and anything it granted)" : "";
        const content =
            `<p>Finished using <strong>${target.name}</strong>?</p>` +
            `<p>Confirming removes it from the sheet${grantNote}.</p>` +
            `<p style="opacity:.7;font-size:.9em">Apply the move's damage first, then confirm.</p>`;

        let confirmed = false;
        try {
            const DialogV2 = foundry.applications?.api?.DialogV2;
            if (DialogV2) {
                confirmed = await DialogV2.confirm({
                    window: { title },
                    content,
                    modal: false,
                    rejectClose: false,
                });
            } else {
                confirmed = await Dialog.confirm({ title, content, rejectClose: false });
            }
        } catch (error) {
            confirmed = false;
        }

        if (confirmed) await this.#applyConsume(targetId);
    }

    /**
     * Perform the decrement / removal on a freshly-fetched target.
     * @param {string} targetId
     */
    async #applyConsume(targetId) {
        const target = this.actor.items.get(targetId);
        if (!target?.id || !this.actor.items.has(target.id)) return;

        const guardKey = `${this.actor.id}:${target.id}`;
        if (ConsumeItemRuleElement.#inFlight.has(guardKey)) return;
        ConsumeItemRuleElement.#inFlight.add(guardKey);

        try {
            const amount = Math.max(1, Math.trunc(Number(this.resolveValue(this.quantity)) || 1));
            const current = Number(target.system?.quantity ?? 1);
            const next = current - amount;

            if (next > 0) {
                await this.actor.updateEmbeddedDocuments("Item", [
                    { _id: target.id, "system.quantity": next },
                ]);
            } else if (this.removeAtZero) {
                await this.actor.deleteEmbeddedDocuments("Item", [target.id]);
            } else {
                await this.actor.updateEmbeddedDocuments("Item", [
                    { _id: target.id, "system.quantity": 0 },
                ]);
            }
        } catch (error) {
            console.error("ptr-consume-item | Failed to consume item", error);
        } finally {
            ConsumeItemRuleElement.#inFlight.delete(guardKey);
        }
    }
}

export { ConsumeItemRuleElement };