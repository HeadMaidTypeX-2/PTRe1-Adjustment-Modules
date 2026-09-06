# PTRe1-Adjustment-Modules

A small bundle of fixes and infrastructure for a **PTU** (system id `ptu`) world on
**Foundry V13/V14**, kept in one module so it installs and updates from one place.
Targets the PTR **release** line (`righthandofvecna/fvtt-ptr`, e.g. `4.4.3.37`).

All components are additive and register at runtime — **no system files are edited.**

## What's inside

Independent components, each under `scripts/`.

### Foundry / integration fixes

1. **`ptr-capability-ruler.js`** — recolours the native token drag-ruler
   (green / yellow / red) based on the dragged token's movement capability for the
   selected Movement Action. *(Requires libWrapper.)*
2. **`aa-user-author-shim.js`** — restores `ChatMessage#user` as an alias of
   `ChatMessage#author`, which Foundry V14 removed. Without it, Automated Animations'
   PTU handler throws and animations never play. No-op on V13.
3. **`shop-description-fix.js`** — mirrors PTU's `system.effect` into the conventional
   `system.description.value` at derived-data time (in memory only — nothing is saved),
   so description-extracting modules like Stylish Shop can read item text.
   *(Requires libWrapper.)*

### Rule elements & mechanics

4. **ConsumeItem rule element** — `init.js`, `consume-item-form.js`, `consume-item.js`.
   Adds a `ConsumeItem` rule element to PTR's item rule options. Registered at runtime.
   On a configurable item/trigger it finds a target item in the actor's inventory,
   decrements its `system.quantity`, and removes the item when the count hits 0. It is the
   embedded-item counterpart to the system's `InstantChange` (which can only modify actor
   data paths, never owned items).

   **Fields**
   - **Trigger** — `onRoll` (default), `onTurnStart`/`End`, `onCombatStart`/`End`,
     `onRoundStart`, `onCreate`, `onDelete`.
   - **Selectors** — (`onRoll` only) roll-domain selectors that must match, e.g. `move-attack`.
   - **Item UUID** — compendium UUID to consume; matched on owned items' `sourceId`. Blank = self.
   - **Item Slug** — alternative to UUID; matches an owned item by slug (e.g. `basic-ball`).
   - **Amount** — quantity removed per trigger (resolvable; default 1).
   - **Remove at 0** — delete the item at 0 (default on).
   - Target priority: **UUID → Slug → self.**

5. **`fix-grant-toggle.js`** — In ptu `4.4.3.37`, `PTUItem#toggleEnableState` references
   `GrantItemRuleElement`, which is `undefined` in the shipped bundle (a dropped import), so
   it throws a `ReferenceError` before reaching the actor update that re-evaluates grants.
   This wrapper catches that specific error and performs the missed actor poke, so grant
   re-evaluation runs on equip/enable toggles. *(Requires libWrapper.)*

6. **`grant-equip-aware.js`** — Registers a custom `GrantItem` rule element (via
   `CONFIG.PTU.rule.elements.custom`, which overrides the builtin) so a *reevaluating* grant
   is not ignored merely because its item is disabled. By default, unequipping an item marks
   its `GrantItem` rule `ignored`, which drops it from `actor.rules`; its retraction
   (`preUpdateActor`) then never runs and the granted item is orphaned. This keeps the rule
   alive so it deletes the grant on unequip and re-creates it on re-equip. Pairs with
   `fix-grant-toggle.js` (which supplies the poke).

   On such a grant, keep `reevaluateOnUpdate: true` and an `item:equipped` predicate.

7. **`turn-state.js`** — Turn-timing infrastructure. Exposes triggers any item/effect rule
   element can reference; **no content is baked in.**
   - **`turn:active`** *(roll option)* — added to `getRollOptions()` whenever the actor is
     the current combatant. Stateless, derived live, self-clearing. Use in any rule element's
     `predicate`. *(Requires libWrapper.)*
   - **`turn-start` / `turn-end`** *(selectors)* — dispatched on `ptu.startTurn` /
     `ptu.endTurn` to the extraction-based elements `Reminder` and `ApplyEffect`. Use as
     `selectors` on those rule elements. Emitted by the primary GM only.

   **Example uses**
   - During-your-turn bonus — `FlatModifier` with `"predicate": ["turn:active"]`.
   - Start-of-turn prompt — `{ "key": "Reminder", "selectors": ["turn-start"], "message": "…" }`.
   - Apply an effect each turn — `{ "key": "ApplyEffect", "selectors": ["turn-start"], "uuid": "…" }`.

8. **Evolution requirements** — `evolution-requirements.js`,
   `evolution-requirements-data.js`. Gates the level-up evolution list on conditions the
   Pokémon actually meets, instead of offering every evolution at once.

   PTR builds that list in `LevelUpData#refresh()` and gates it with
   `PokemonGenerator.isEvolutionRestricted()`, but that gate never fires: it understands only
   `"male"` / `"female"` and treats every other restriction string as unrestricted, and the
   level-up form calls it with a bare value where a `{ gender }` object is expected — against
   `this.pokemon.gender`, which is not a property (`system.gender` is). So an Eevee at level 25
   offered all 19 of its level-25 evolutions and the form preselected one **at random**.

   **Restriction grammar** — case- and punctuation-insensitive:
   - `""` — no requirement (the system's own default).
   - `male` / `female` — matched against `system.gender`.
   - `item:<slug>` — matched against `system.heldItem`.
   - `gm` — GM permission: selectable by a GM, blocked for players.
   - A bare item name listed in `ITEM_ALIASES` — makes the compendium's existing
     `Thunderstone`, `Fire Stone`, `Ice Stone` and `Sweet` tags work as written.
   - Anything else — **blocked**, with a console warning naming the species and tag.

   **Behaviour**
   - Players see only evolutions that qualify; a GM sees all of them, with unmet ones disabled
     in the dropdown and the reason appended to the label.
   - Exactly one qualifying evolution is preselected. Several means the form defaults to
     "stay as you are" so the choice is deliberate — this is what replaces the random pick.
   - "Stay as your current species" is never gated.
   - Requirements live in `EVOLUTION_REQUIREMENTS` (slug-keyed, no UUIDs); an entry there
     overrides the species item's own restrictions. Species absent from it are untouched.

   Scope is the level-up screen only — random NPC generation still uses the system's own path.

   > The Eevee entries in the data file are a **draft, not sourced from PTR** — the shipped
   > species item carries no restrictions to copy. The three stone lines are the mainline ones
   > and their items exist; everything else is a `gm` placeholder standing in for a condition
   > (loyalty, time of day, location) this module cannot yet evaluate. Confirm against
   > `1e.ptr.wiki` before treating any of it as a rule.

## Requirements

- Foundry VTT V13 or V14
- System: `ptu` (PTR release line, e.g. `4.4.3.37`)
- [libWrapper](https://github.com/ruipin/fvtt-lib-wrapper) (declared as a required dependency)

## Install

In Foundry → **Add-on Modules → Install Module**, paste the manifest URL:

```
https://github.com/HeadMaidTypeX-2/PTRe1-Adjustment-Modules/releases/latest/download/module.json
```