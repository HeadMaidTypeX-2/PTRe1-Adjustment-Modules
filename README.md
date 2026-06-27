# PTRe1-Adjustment-Modules

A small bundle of fixes for a **PTU** (system id `ptu`) world on **Foundry V13/V14**,
kept in one module so it installs and updates from one place.


## What's inside

Three independent scripts, each its own file under `scripts/`:

1. **`ptr-capability-ruler.js`** — recolours the native token drag-ruler
   (green / yellow / red) based on the dragged token's movement capability for
   the selected Movement Action. *(Requires libWrapper.)*
2. **`aa-user-author-shim.js`** — restores `ChatMessage#user` as an alias of
   `ChatMessage#author`, which Foundry V14 removed. Without it, Automated
   Animations' PTU handler throws and animations never play. No-op on V13.
3. **`shop-description-fix.js`** — mirrors PTU's `system.effect` into the
   conventional `system.description.value` at derived-data time (in memory
   only — nothing is saved), so description-extracting modules like Stylish
   Shop can read item text. *(Requires libWrapper.)*
4. **`init.js` , `consume-item-form.js`, `consume-item.js`** — Adds a "ConsumeItem" rule element to PTR's Items Rule options. Registers at runtime, no files are edited. On a configurable item/trigger, it finds a target item in the actor's inventory, decrements its system.quantity, and removes the item when the count hits 0. It is embedded-item counterpart to the system's InstantChange (Which can only modify actor data paths, never owned items). 
Fields
Trigger — onRoll (default), onTurnStart/End, onCombatStart/End, onRoundStart,
onCreate, onDelete.
Selectors — (onRoll only) roll-domain selectors that must match, e.g. move-attack.
Item UUID — compendium UUID to consume; matched on owned items' sourceId. Blank = self.
Item Slug — alternative to UUID; matches an owned item by slug (e.g. basic-ball).
Amount — quantity removed per trigger (resolvable; default 1).
Remove at 0 — delete the item at 0 (default on).
Target priority: UUID -> Slug -> self.

## Requirements

- Foundry VTT V13 or V14
- System: `ptu`
- [libWrapper](https://github.com/ruipin/fvtt-lib-wrapper) (declared as a required dependency)

## Install

In Foundry → **Add-on Modules → Install Module**, paste the manifest URL:

```
https://github.com/HeadMaidTypeX-2/PTRe1-Adjustment-Modules/releases/latest/download/module.json
```
