import { RuleElementPTU } from "/systems/ptu/src/module/rules/rule-element/base.js";
import { ResolvableValueField } from "/systems/ptu/src/module/system/schema-data-fields.js";
import { sluggify } from "/systems/ptu/src/util/misc.js";

/**
 * ConsumeItem Rule Element
 *
 * On a configurable trigger, finds a target item in the actor's inventory and decrements its
 * `system.quantity`. When the quantity reaches 0 (or below) the item is removed from the actor.
 *
 * This is the embedded-document counterpart to InstantChange: where InstantChange performs an
 * `actor.update()` on a data path (and therefore cannot reach owned items), ConsumeItem operates
 * directly on the embedded Item collection via update/deleteEmbeddedDocuments.
 *
 * Target resolution (priority order):
 *   1. `uuid`       → owned item whose source matches this compendium UUID (item.sourceId).
 *   2. `targetSlug` → owned item whose slug matches.
 *   3. neither      → the item carrying this rule (self).
 *
 * Pairs with GrantItem(cascade): put a ConsumeItem on a single-use scroll, trigger "onRoll", and
 * firing the granted move decrements the scroll; at 0 it deletes itself and the cascade removes
 * the granted move with it.
 */
class ConsumeItemRuleElement extends RuleElementPTU {
    /** Guards against re-entrant deletion (e.g. onDelete targeting self). */
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
            /** Roll-domain selectors; only meaningful when trigger is "onRoll". */
            selectors: new fields.ArrayField(
                new fields.StringField({ required: true, blank: false, initial: undefined }),
                { required: false, nullable: false, initial: [] }
            ),
            /** Compendium UUID of the item to consume. Matched against owned items' sourceId. */
            uuid: new fields.StringField({ required: false, nullable: true, blank: false, initial: null }),
            /** Slug of the item to consume. Used when no uuid is given. */
            targetSlug: new fields.StringField({ required: false, nullable: true, blank: false, initial: null }),
            /** How many to remove per trigger. Resolvable; defaults to 1. */
            quantity: new ResolvableValueField({ required: false, nullable: false, initial: 1 }),
            /** When the resulting quantity is <= 0, delete the item from the actor. */
            removeAtZero: new fields.BooleanField({ required: false, nullable: false, initial: true }),
        };
    }

    /* -------------------------------------------- */
    /* Trigger hooks                                */
    /* -------------------------------------------- */

    /* The batched-data hooks are awaited by their callers, so it is safe to perform an async
       embedded-document operation here. We ignore the passed actorUpdates dict because we mutate
       the items collection directly rather than the actor's own data. */

    async onCreate() {
        if (this.trigger === "onCreate") await this.#consume();
    }

    async onDelete() {
        if (this.trigger === "onDelete") await this.#consume();
    }

    async onTurnStart() {
        if (this.trigger === "onTurnStart") await this.#consume();
    }

    async onTurnEnd() {
        if (this.trigger === "onTurnEnd") await this.#consume();
    }

    async onCombatStart() {
        if (this.trigger === "onCombatStart") await this.#consume();
    }

    async onCombatEnd() {
        if (this.trigger === "onCombatEnd") await this.#consume();
    }

    async onRoundStart() {
        if (this.trigger === "onRoundStart") await this.#consume();
    }

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

    /**
     * Resolve the owned item this rule should consume.
     * @returns {Item|null}
     */
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

        // Default: the item carrying this rule.
        return this.item ?? null;
    }

    /**
     * Perform the decrement / removal.
     * @param {Set<string>|string[]} [rollOptions] Roll options for predicate testing.
     */
    async #consume(rollOptions) {
        if (this.ignored) return;

        const options = rollOptions
            ? Array.from(rollOptions)
            : Array.from(new Set(this.actor.getRollOptions()));
        if (!this.test(options)) return;

        const target = this.#resolveTarget();
        if (!target?.id) return;

        // Bail if the target has already left the inventory.
        if (!this.actor.items.has(target.id)) return;

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
