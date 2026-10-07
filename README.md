# PTRe1-Adjustment-Modules

A small bundle of fixes and infrastructure for a **PTU** (system id `ptu`) world on
**Foundry V13/V14**, kept in one module so it installs and updates from one place.
Targets the PTR **release** line (`righthandofvecna/fvtt-ptr`), **`4.4.3.49` or later**.
Earlier releases of this module match earlier system versions: use 0.7.0 on 4.4.3.37, and the
last 0.8.x release before the predicate rework on 4.4.3.44.

All components are additive and register at runtime. **No system files are edited.**

## Turning features on and off

**Game Settings → Configure Settings → PTRe1 Adjustment Modules → Configure Adjustments** (GM
only) opens a window listing every feature below. Each has a description and an on/off switch.
Everything is on by default.

- **Live** features take effect immediately.
- **Reload** features patch the system or Foundry once at startup. Changing one asks to reload
  the world. These are ConsumeItem, the evolution add-ons, the trainer OR-prerequisite fix, the
  Automated Animations shim and the Stylish Shop adapter.
- A feature whose required module isn't active is marked *Inactive* and does nothing either way.

Switching off one of the DGA replacements (the cell picker, Sliding Ice, or Reinforcements' Via
Script spawning) hands control back to DGA's own code. Switching off the Rock Climb / Waterfall
behaviors brings back Pokémon Assets' old placement tools. The behaviors go inert but stay
registered, so existing regions remain valid.

The switches are stored as hidden world settings, `PTRe1-Adjustment-Modules.feature.<id>`.

## What's inside

Independent components, each under `scripts/`.

### Foundry / integration fixes

- **`type-overwrite-display-fix.js`** — since PTR 4.4.3.48, TypeOverwrite works in combat
  (STAB, damage, type effectiveness all read `actor.types`). But a Pokémon's `system.typing` is
  calculated before rule elements run. The sheet's type icons and damage preview read
  `system.typing`, so they still showed the species types. This copies the override onto
  `system.typing` after the rules run. It is redundant once PTR fixes it upstream.
  *(Requires libWrapper.)*

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
5. **`trainer-prereq-or-fix.js`** — fixes "or" prerequisites in the Trainer Level-Up window.
   PTR matched one pattern against the whole string, so only one alternative was ever
   checked. `Adept Guile or Stealth` ignored Stealth, Tutelage-style `Level 10 or Two of …`
   checked only the level, and Athlete ignored Novice Athletics. Each alternative is now
   checked on its own. Malformed skill prerequisites in PTR's data are also read correctly:
   - typos and abbreviations (Hunter's `Survial`, `Technology Ed`)
   - "and" and ";" (Enduring Soul, Stat Stratagem, Dancer, Choreographer)
   - missing separators (Mentoring, Seed Bag Rank 1, Rogue)
   - an "or" split across entries (Mystic)
   - class skills: Street Brawler's "Adept in 2 Rogue Skills" uses the skills in the Rogue
     feature's own prerequisite (Acrobatics, Athletics, Stealth), read from the data rather
     than hardcoded

   It also fixes the class gate for multi-word Class Rework classes. PTR compared
   `glamour-weaver` with the item's `glamour-weaver-cr` slug, so a Class Rework Glamour
   Weaver never qualified for Fey Law. This affected 37 classes and 221 features.

   The window still shows PTR's original text. Remove once fixed upstream.

### Pokémon Assets / Dylan's General Automations fixes

Each is a no-op unless Dylan's General Automations (DGA) is active.

- **`paint-area-fix.js`** — replaces DGA's `UserPaintArea` cell picker, used by Pokémon
  Assets' *Place Climbable Rocks* / *Place Waterfall* and DGA's Door destination. The original
  is a MeasuredTemplate subclass that can stall the canvas render loop (token animations stop).
  The replacement draws a plain square, never switches layers, and keeps the same contract:
  left-click resolves the cell, right-click or Escape cancels.
- **`sliding-ice-fix.js`** — replaces the Sliding Ice region behavior's handler with one that
  always releases the token, even on error. The original could leave a token permanently
  locked until reload. Slides start from the token's grid-snapped position and stop only
  once the token is completely off the ice, on the cell bordering it. On square grids,
  movement on ice is cardinal only: diagonal steps that start or end on ice are blocked.

  *Known limitations for tokens larger than 1×1* (not fixed; large tokens rarely cross ice):
  - **Late trigger.** Foundry counts a token as inside a region by its centre point, so a
    2×2 token's first step onto the ice (half its body on it) doesn't slide; the slide starts
    on the next step.
  - **Walls checked along the centre line only.** A wall blocking just one of the token's rows
    or columns can be missed, letting it slide partly through the wall. DGA's original has
    the same weakness.
  - **The diagonal block tests one cell, not the whole footprint.** Some diagonal moves where
    only part of the token touches ice get through.

  The stop position and grid alignment work correctly at any size.
- **`field-move-regions.js`** — removes Pokémon Assets' *Place Climbable Rocks* / *Place
  Waterfall* region tools. Adds **Rock Climb** and **Waterfall** Region Behaviors that work
  like Surf: draw a region over the rock face or waterfall and add the behavior. Tokens can't
  walk in. Facing it and pressing Interact crosses the region in a straight line, either way,
  if the party knows the move (Pokémon Assets' own check, setting and prompt). The old tools
  made locked regions; a GM console report lists them on load, and
  `game.modules.get("PTRe1-Adjustment-Modules").api.removeLegacyClimbRegions()` deletes them.
  Needs Pokémon Assets and DGA. The world must be relaunched once so Foundry picks up the new
  behavior types.
- **`reinforcement-round-end.js`** — implements the Reinforcements Platform's *Round End*
  trigger, which DGA offers but never runs. At the end of each combat round (from a per-tile
  starting round), every enabled Round End platform spawns one reinforcement and adds it to
  the combat. Tile Config gains a *Reinforcements* section (trigger, enabled, starting round).
  Compendium actors are imported once and reused; an occupied platform waits.
  A per-tile **Spawn unlinked tokens** toggle (default on, also shown in the placement dialog)
  gives each spawn its own copy of the actor. PTR forces actors to be linked, so without it
  every spawn shares one sheet. It also applies to the *Via Script* trigger, but not to DGA's
  *Scene Creation* trigger.

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

6. **Evolution add-ons** — `evolution-requirements.js`. Since 4.4.3.46 each evolution row on
   a species sheet has a single native **Predicate** field, which the level-up screen tests
   against the Pokémon's roll options. This component adds only what PTR lacks.

   **Native predicates (PTR source, 4.4.3.46).** These need nothing from this module:

   | Predicate | Meaning |
   |---|---|
   | `self:level:25+` | reaches level 25 |
   | `self:gender:female` | is female |
   | `self:spirit:3+` | Spirit 3 or more |
   | `item:<slug>` | owns that item, e.g. `item:thunder-stone` |
   | `ability:<slug>`, `move:<slug>`, `condition:<slug>` | has that ability, move or condition |
   | `party:species:<slug>` | another Pokémon of that species is in the party (flag-based) |
   | `["or", a, b]`, `["not", a]` | compound statements |

   **Extra roll options added here.** Use them in the same Predicate field:

   | Predicate | Meaning |
   |---|---|
   | `self:stat:atk>def` | Attack total above Defence. `<` and `=` also exist, for every stat pair. |
   | `self:stat:levelup:atk>def` | the same comparison on the points the player invested (Tyrogue) |
   | `self:stat:spatk:20+` | Special Attack total of 20 or more |
   | `self:loyalty:4+`, `self:friendship:N+` | loyalty or friendship threshold |
   | `self:movetype:fairy` | knows any Fairy-type move |
   | `party:species:<slug>` | also counts the trainer's **Party folder**, like the Party screen does |
   | `item:<slug>` | also counts the legacy `system.heldItem` text |
   | `user:gm` | selectable only by a GM |

   Stat keys are `hp`, `atk`, `def`, `spatk`, `spdef`, `spd`. These options exist only on the
   level-up screen, not in random NPC generation.

   **Behaviour**
   - **Edits reach existing Pokémon.** A Pokémon's species is a snapshot that PTR never re-syncs.
     During level-up, each evolution's predicate is read from the source species item, so an
     edit to the world or compendium species applies to Pokémon that already exist.
   - **GM view.** Players see only qualifying evolutions. A GM also sees blocked ones, disabled,
     with the failing parts appended ("Escavalier — needs Shelmet in the party"). Evolutions
     whose level isn't reached yet stay hidden.
   - A GM is never auto-selected into a `user:gm` evolution.
   - **Confirming an evolution spends its items.** Each top-level `item:<slug>` in the chosen
     evolution's predicate consumes one of that item: the smallest stack is decremented and
     deleted at 0. Items inside `or`/`not` compounds are not consumed. Staying as the current
     species, or closing with X, consumes nothing.

   **Upgrading from 4.4.3.44.** PTR's migration converted Level, gender and the Item cell into
   predicates and **dropped every other restriction** (`party:`, `loyalty>=`, `stat:`, `gm`,
   and compendium tags like `Thunderstone`). It also wrote abilities, moves and conditions from
   the Item cell as `item:<slug>`, which can never pass. On load, the GM gets a notification and
   a console table listing each affected row with the predicate to add. The old text survives
   only until that species sheet is next saved, so re-enter the predicates before editing.

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

**Rewritten in 4.4.3.46: evolution gating.** PTR now gates evolutions with native
predicates. This module's own restriction grammar and `evolution-drop-targets.js` were
removed. Component 6 now only adds to the native system.

## Requirements

- Foundry VTT V13 or V14
- System: `ptu` (PTR release line, `4.4.3.49` or later)
- [libWrapper](https://github.com/ruipin/fvtt-lib-wrapper) (declared as a required dependency)

## Install

In Foundry → **Add-on Modules → Install Module**, paste the manifest URL:

```
https://github.com/HeadMaidTypeX-2/PTRe1-Adjustment-Modules/releases/latest/download/module.json
```