import { RuleElements } from "/systems/ptu/src/module/rules/index.js";
import { RULE_ELEMENT_FORMS } from "/systems/ptu/src/module/item/sheet/rule-elements/index.js";
import { ConsumeItemRuleElement } from "./consume-item.js";
import { ConsumeItemForm } from "./consume-item-form.js";

const MODULE_ID = "PTRe1-Adjustment-Modules";
const TEMPLATE = `modules/${MODULE_ID}/templates/consume-item.hbs`;

Hooks.once("init", () => {
    try {
        // Register the rule element into the system's custom registry.
        // RuleElements.all = { ...builtin, ...custom }, and the item sheet builds its
        // "add rule" dropdown from Object.keys(RuleElements.all), so this also makes it
        // selectable in the UI (labelled via RULES.Types.ConsumeItem in our lang file).
        RuleElements.custom["ConsumeItem"] = ConsumeItemRuleElement;

        // Register the sheet form. The sheet resolves RULE_ELEMENT_FORMS[key] ?? RuleElementForm,
        // and this is the same object instance the sheet imports, so the new key is picked up.
        RULE_ELEMENT_FORMS["ConsumeItem"] = ConsumeItemForm;

        // Preload the form template (optional; renderTemplate would load it on demand anyway).
        const loadTemplatesFn =
            foundry.applications?.handlebars?.loadTemplates ?? globalThis.loadTemplates;
        loadTemplatesFn?.([TEMPLATE]);

        console.log(`${MODULE_ID} | ConsumeItem rule element registered.`);
    } catch (error) {
        console.error(`${MODULE_ID} | Failed to register ConsumeItem. Is the 'ptu' system active and running from source?`, error);
    }
});
