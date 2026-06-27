import { RuleElementForm } from "/systems/ptu/src/module/item/sheet/rule-elements/base.js";

class ConsumeItemForm extends RuleElementForm {
    /** @override */
    get template() {
        return "modules/ptr-consume-item/templates/consume-item.hbs";
    }

    /** @override */
    async getData() {
        const data = await super.getData();

        if (this.rule.predicate === undefined) this.updateItem({ predicate: [] });

        const ruleTriggers = {
            "onCreate":       "PTU.RuleEditor.ConsumeItem.Triggers.OnCreate",
            "onDelete":       "PTU.RuleEditor.ConsumeItem.Triggers.OnDelete",
            "onTurnStart":    "PTU.RuleEditor.ConsumeItem.Triggers.OnTurnStart",
            "onTurnEnd":      "PTU.RuleEditor.ConsumeItem.Triggers.OnTurnEnd",
            "onCombatStart":  "PTU.RuleEditor.ConsumeItem.Triggers.OnCombatStart",
            "onCombatEnd":    "PTU.RuleEditor.ConsumeItem.Triggers.OnCombatEnd",
            "onRoundStart":   "PTU.RuleEditor.ConsumeItem.Triggers.OnRoundStart",
            "onRoll":         "PTU.RuleEditor.ConsumeItem.Triggers.OnRoll",
        };

        return {
            ...data,
            ruleTriggers,
            selectorsAsString: (this.rule.selectors ?? []).join(", "),
            predicationIsMultiple: Array.isArray(this.rule.predicate) && this.rule.predicate.every(p => typeof p === "string"),
        };
    }

    /** @override */
    activateListeners(html) {
        html.querySelector("[data-action=toggle-predicate]")?.addEventListener("click", () => {
            const predicate = this.rule.predicate;
            const newValue = Array.isArray(predicate)
                ? { "and": predicate.length ? predicate : [] }
                : predicate?.["and"]?.length ? predicate["and"] : [];
            this.updateItem({ predicate: newValue });
        });
    }

    /** @override */
    _updateObject(formData) {
        // Comma-separated selectors string back to array
        if (typeof formData.selectors === "string") {
            formData.selectors = formData.selectors
                .split(",")
                .map(s => s.trim())
                .filter(s => !!s);
        }

        // Coerce quantity to a number when it is a plain value
        if (formData.quantity !== undefined && formData.quantity !== null && formData.quantity !== "") {
            formData.quantity = this.coerceNumber(formData.quantity);
        }

        if (Array.isArray(formData.predicate) && formData.predicate.every(p => !!p.value)) {
            formData.predicate = formData.predicate.map(s => s.value).filter(s => !!s);
        }

        // Drop empty optionals so they fall back to schema defaults
        for (const optional of ["label", "uuid", "targetSlug"]) {
            if (!formData[optional]) {
                delete formData[optional];
            }
        }
    }
}

export { ConsumeItemForm };
