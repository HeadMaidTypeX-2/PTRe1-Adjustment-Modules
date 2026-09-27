# PTRe1-Adjustment-Modules

A small bundle of fixes and infrastructure for a **PTU** (system id `ptu`) world on
**Foundry V13/V14**, kept in one module so it installs and updates from one place.
Targets the PTR **release** line (`righthandofvecna/fvtt-ptr`), **`4.4.3.44` or later**.
Version 0.8.0 is the first release built against 4.4.3.44. It will not work correctly on
4.4.3.37; use 0.7.0 there.

All components are additive and register at runtime. **No system files are edited.**

## What's inside

Independent components, each under `scripts/`.

### Foundry / integration fixes

1. **`ptr-capability-ruler.js`** — recolours the native token drag-ruler
   (green / yellow / red) based on the dragged token's movement capability for the
   selected Movement Action. *(Requires libWrapper.)*
2. **`aa-user-author-shim.js`** — restores `ChatMessage#user` as an alias of
   `ChatMessage#author`, which Foundry V14 removed. Without it, Automated Animations'
   PTU handler throws and animations never play. No-op on V13.
3. **`ptu-adapter.js`** — registers a PTU adapter with Stylish Shop's
   `registerSystemAdapter` API, so the shop reads descriptions from `system.effect` and prices
   from `system.cost`. Currency is configured separately: in the GlitchSmith Library currency
   dialog, point a sheet currency at `system.money`.
4. **`gift-keyword-bridge.js`** — copies each item's PTU `system.keywords` into
   Stylish Relationship Tracker's `giftTags` flag, lowercased, so item keywords work as gift
   tags without hand-tagging. It only adds tags and never removes ones you added by hand. It
   syncs on item create and update, and a one-time backfill runs for the GM on load.

### Rule elements & mechanics

5. **ConsumeItem rule element** — `init.js`, `consume-item-form.js`, `consume-item.js`.
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

6. **Evolution requirements** — `evolution-requirements.js`. Gates the level-up evolution
   list on conditions the Pokémon actually meets, read from the species item itself.

   Each evolution row on a species sheet has an **Item** cell (`evolution.other.evolutionItem`)
   and a **Restriction** text column (`evolution.other.restrictions`). Since 4.4.3.44 the
   system reads both, but only in a limited way (see *Relationship to the PTR system* below).
   This component replaces the system's check with a fuller one during level-up.

   **How to use it:** open the species item and drop the requirement onto an evolution row's
   **Item** cell. The system's own drop handler only accepts documents of type `item`, so
   `evolution-drop-targets.js` (component 7) widens it to abilities, moves, Poké Edges,
   capabilities, contest moves, spirit actions **and conditions/effects** — everything a
   Pokémon can own. Drag Poisoned from the PTR Effects compendium onto a row and that
   evolution is only offered while the Pokémon is poisoned. Drop Own
   Tempo on Lycanroc Dusk and it means "must have Own Tempo". Clear the cell to remove the
   requirement. Conditions that are computed rather than possessed go in the **Restriction**
   column instead.

   **What is checked**
   - The dropped **requirement**, against what the Pokémon owns. Matching is scoped to the
     dropped document's own type, so an ability requirement looks at the actor's abilities and
     an item requirement at its items. Items are the "Held Items" panel, which is not a field —
     it lists owned documents of type `item` — and a stack at quantity 0 does not count. The
     trainer sheet's `system.heldItem` text field is also honoured for older data. Matching
     ignores case, spacing and punctuation, so `"King's Rock"` matches `kings-rock` and the
     compendium's `"Thunderstone"` matches `thunder-stone`. Rows written before the drop target
     was widened carry no type and are matched against everything the actor owns.
   - The **Restriction** text, in this order:
     - blank — no requirement.
     - `male` / `female` — against `system.gender`.
     - `gm` (or `GM Permission`) — selectable by a GM, blocked for players.
     - `item:<slug>` — same as dropping the item on the row.
     - `condition:<slug>` (also `effect:` or `status:`) — the Pokémon currently has that
       condition, e.g. `condition:poisoned`, `condition:fainted`. **PTR's slug for "asleep" is
       `sleep`.** Checked against the live `rollOptions.conditions` registry first, then the
       `actor.conditions` map, then owned condition/effect documents.
     - `move:<slug>` — knows that move. `movetype:<element>` — knows any move of that type;
       validated against PTR's real element list, so a contest type is rejected rather than
       silently never matching.
     - `stat:atk>def` — compares stats as played. `stat:levelup:atk>def` compares the points
       the player actually invested, which is the Tyrogue question; `stat:value:` uses the
       pre-level-up figure. Operators `> < >= <= = !=`, and the right side may be another stat
       or a number (`stat:spatk>=20`).
     - `loyalty>=4`, `friendship>=N`, `level>=N` — numeric comparisons on the actor.
     - `party:<species-slug>` — another Pokémon of that species is in the trainer's party,
       e.g. `party:shelmet` on Karrablast → Escavalier. The party is resolved the same way as
       PTR's Party screen: the trainer's **Party** folder if one exists, otherwise Pokémon
       assigned to the trainer and not boxed. The evolving Pokémon never counts toward its
       own requirement, so `party:eevee` on an Eevee needs a *second* Eevee. A Pokémon with no
       trainer assigned falls back to its own **Party** folder; with neither, it is blocked. Party checks can't be combined inside a JSON predicate, but
       separate entries still AND together.
     - **Anything containing a colon is a roll-option statement**, handed to PTR's own
       `PTUPredicate` and tested against `actor.getRollOptions()`. That covers everything the
       system already publishes about an actor — `self:types:fairy`, `self:ability:own-tempo`,
       `self:pokemon:shiny`, `self:atk:stage:2`, `pokeedge:<slug>` — plus anything a rule
       element injects. Compound predicates go in as JSON:
       `["or", "self:ability:own-tempo", "self:pokemon:shiny"]`. Invalid JSON blocks the
       evolution and says so in the console rather than being read as an item name.

       The sheet stores this column as `restrictions.split(",")`, so a compound you type is
       shredded into fragments on save. This component reassembles anything between an
       unbalanced opening bracket and its closing partner, so JSON compounds survive being
       authored through the UI. **Multiple entries are ANDed**, so `movetype:fairy, loyalty>=4`
       needs no JSON at all — reach for a predicate only when you want OR or NOT.
     - Any other text is treated as a held-item requirement and logged once, so the
       compendium's bare tags (`Thunderstone`, `Ice Stone`, `Sweet`) keep working — prefer
       dropping the item instead.

   **Behaviour**
   - Players see only evolutions that qualify; a GM sees all of them, with unmet ones disabled
     in the dropdown and the reason appended ("Vaporeon — needs held Water Stone").
   - Exactly one *earned* evolution is preselected. Several means the form defaults to "stay as
     you are" so the choice is deliberate — this replaces the random pick. GM permission does
     not count toward earning, so a GM is never auto-evolved into a GM-gated form.
   - "Stay as your current species" is never gated.
   - **Confirming an evolution spends its item — and only an item.** An ability, move or Poké
     Edge attached to a row is a *condition*, never a cost, and is never touched. On Submit, an
     attached document of type `item` is decremented by one and deleted when the stack hits 0 — the same
     decrement-and-delete the ConsumeItem rule element uses. With several stacks of the same
     item, the smallest is spent first. Nothing is consumed if you stay as your current
     species, if the evolution has no attached item, or if the requirement came from
     restriction *text* rather than the Item column — spending an item on a fuzzy string match
     is not done silently. Closing the window with X consumes nothing.

   **Editing a species item reaches Pokémon that already exist.** `actor.species` is an owned
   *snapshot* of the species item, taken when the Pokémon was created, and the system never
   syncs it. So a requirement you add today would not reach a Pokémon made yesterday. This
   component falls back to the source species item (via `compendiumSource` / `core.sourceId`)
   for any evolution row the embedded copy does not describe.

   Set `CONFIG.debug.ptreEvolution = true` in the console to log, per level-up, what each
   evolution required, whether it was blocked, and whether the requirement came from the
   embedded copy or the source item.

   Scope is the level-up screen only — random NPC generation still uses the system's own path.

7. **`evolution-drop-targets.js`** — widens the species sheet's per-evolution **Item** drop
   target. The system only records documents of type `item` there. Any other type falls
   through to the sheet's normal handling, so an ability dropped on an evolution row is added
   to the species' Basic Abilities instead. This wraps `PTUSpeciesSheet#_onDrop`. A drop landing
   on `.evolution-item` accepts `item`, `ability`, `move`, `contestmove`, `pokeedge`,
   `capability`, `spiritaction`, `condition` and `effect`. Any other type is refused with a
   notification. All other drops pass through untouched.

   The stored record adds `type` and `name`. The `type` is what lets component 6 tell a *cost*
   from a *condition*, so only a real `item` is ever consumed on evolution. The system's own
   check in 4.4.3.44 also reads `type`.

## Relationship to the PTR system

**Moved upstream in 4.4.3.44 and removed here.** These are now native. Existing rule elements
that use them keep working unchanged:

- the `turn:active` roll option, e.g. `FlatModifier` with `"predicate": ["turn:active"]`
- the `turn-start` / `turn-end` selectors for `Reminder` and `ApplyEffect`, e.g.
  `{ "key": "Reminder", "selectors": ["turn-start"], "message": "…" }`
- the GrantItem enable-toggle fix (the old `fix-grant-toggle.js`)
- equip-aware GrantItem retraction, where an unequipped item's grant is removed (the old
  `grant-equip-aware.js`). For these grants, keep `reevaluateOnUpdate: true` and an
  `item:equipped` predicate.

**Evolution gating overlaps.** 4.4.3.44 added its own, narrower evolution check:

| | System (4.4.3.44) | This module |
|---|---|---|
| Gender restriction | ✔ | ✔ |
| Item cell: held item | ✔ | ✔, plus the legacy `system.heldItem` text |
| Item cell: ability, move, edge, condition… | Matches by type, but only a `type` recorded by component 7 makes it possible | ✔ |
| Any other restriction text | **Always hidden**, even for compendium tags like `Thunderstone` | Evaluated (see above) |
| Stats, loyalty, level, moves known, party members, predicates | — | ✔ |
| Edits to a species reach existing Pokémon | — | ✔ |
| GM sees blocked options with the reason | — (hidden) | ✔ |
| Consumes the item on evolving | — | ✔ |
| Multiple options default to "stay as you are" | ✔ | ✔ |

Because the system's check removes rows before this module sees them, component 6 switches it
off while the level-up list is built, then restores it. NPC generation still uses the system's
check unchanged.

## Requirements

- Foundry VTT V13 or V14
- System: `ptu` (PTR release line, `4.4.3.44` or later)
- [libWrapper](https://github.com/ruipin/fvtt-lib-wrapper) (declared as a required dependency)

## Install

In Foundry → **Add-on Modules → Install Module**, paste the manifest URL:

```
https://github.com/HeadMaidTypeX-2/PTRe1-Adjustment-Modules/releases/latest/download/module.json
```