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

## Requirements

- Foundry VTT V13 or V14
- System: `ptu`
- [libWrapper](https://github.com/ruipin/fvtt-lib-wrapper) (declared as a required dependency)

## Install

In Foundry → **Add-on Modules → Install Module**, paste the manifest URL:

```
https://github.com/HeadMaidTypeX-2/PTRe1-Adjustment-Modules/releases/latest/download/module.json
```
