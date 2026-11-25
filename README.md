# PTRe1-Adjustment-Modules

A small bundle of fixes and infrastructure for a **PTU** (system id `ptu`) world on
**Foundry V13/V14**, kept in one module so it installs and updates from one place.
Targets the PTR **release** line (`righthandofvecna/fvtt-ptr`), **`4.4.3.57` or later**.
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

- **`battle-transitions-fix.js`** — for Battle Transitions 2.0.14 running on V14 (its manifest
  caps it at V13). Its auto-trigger watches `Scene#update` for activation, which V14's new
  `Scene#activate` bypasses, so auto-trigger scenes never played. This catches activation in
  `preUpdateScene` and plays the transition for everyone. Optionally, viewing an auto-trigger
  scene plays it for the viewing user only. Two Live toggles. If a scene won't trigger, run
  `game.modules.get("PTRe1-Adjustment-Modules").api.battleTransitions.diagnose()`.
  *(Requires libWrapper; no-op without Battle Transitions.)* Not yet tested in play.

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

   Grouped prerequisites added in PTR 4.4.3.58 (`All A or B options` followed by `A: …` and
   `B: …` lines, as on Type Ace (Dark) (Class Rework)) are checked as a whole: the feature
   qualifies when every line of at least one group passes, and each line still gets the "or"
   fixes above.

   The window still shows PTR's original text. Remove once fixed upstream.

### Pokémon Assets / Dylan's General Automations fixes

Each is a no-op unless Dylan's General Automations (DGA) is active.

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
- **`field-move-cry.js`** — when a Pokémon uses a field move (Cut, Rock Smash, Strength,
  Whirlpool, Rock Climb, Waterfall, Headbutt, Surf), a framed window with its portrait opens
  in the middle of the screen, above the "*name* used *move*!" text box, and its cry plays,
  like talking to Pikachu in Pokémon Yellow. Both close together when the text is dismissed,
  and only then does the move go ahead. The Pokémon is found by name in the controlled token's
  party (else among Pokémon you own); its picture is the actor image, else the species image;
  the cry comes from Pokémon Assets and plays for you only, at DGA's *Cry* volume. Trainers,
  or Pokémon that can't be identified, get the plain message. Needs Pokémon Assets and DGA.
- **`pokemon-cry.js`** — the same portrait, cry and text box on demand, for every connected
  player. Make a Script macro containing
  `game.modules.get("PTRe1-Adjustment-Modules").api.cry()`, select one or more Pokémon tokens
  and run it. It asks for a line (`{name}` is the Pokémon's name; blank means "*name*!"), then
  each Pokémon cries in turn. Everyone hears the cry at their own *Cry* volume and closes their
  own text box. Pass the line to skip the question: `api.cry({ text: "{name} roars!" })`.
  Turning the feature off shows it to the player who ran it only. Needs Pokémon Assets and DGA.
- **`reinforcement-unlinked.js`** — DGA 1.0.8+ runs the Reinforcements Platform's triggers
  itself, including Round End, start round, wait-while-occupied and adding spawns to combat.
  This module's own Round End handler was removed, because running both spawned every
  platform twice. What remains is a per-tile **Spawn unlinked tokens** option, default on, shown
  in the placement dialog and in DGA's Reinforcements section of Tile Config. It covers all
  three triggers. Platforms configured with the old Round End fields have their start round
  copied into DGA's own setting on first load.


### Scenes & regions

- **`dialogue-trees.js`** — dialogue scripts played in the text box (DGA's footer box when DGA
  is active, a Foundry dialog otherwise), on regions and tiles. As with DGA's field moves, each
  text box opens with DGA's interaction sound, following its *Interact* volume and its
  interact-sound setting.

  **Regions:** add a **Dialogue** Region Behavior.
  - *Start with*: **Interact** (default; face the region and press DGA's Interact key, Enter,
    as with Surf and Rock Climb; needs DGA, otherwise walking in is used) or **Walking in**.
  - *Block entry* (default on): tokens can't walk in until the dialogue ends in `!enter`; a
    move into the region stops at its edge. With Interact, `!enter` steps the token one cell in;
    with Walking in, it finishes the move. This is the boss-room threshold. Turned off, tokens
    walk in freely and the dialogue simply plays: a sign, a warning, an NPC area.

  **Tiles:** Tile Config has a **Dialogue** section (enable it, write the script). A token facing
  the tile and pressing Interact plays it. Needs DGA. `!enter`/`!done` and `!stay` only matter
  for *Ask again* on tiles.

  The script, for example a threshold:

  ```
  [start]
  !if not item:rising-badge -> unprepared
  You feel an ominous presence beyond this threshold...
  ---
  Are you sure you are ready to proceed?
  > Yes -> enter
  > No -> leave

  [unprepared]
  Your Pokémon seem uneasy without the badge...
  > Go in anyway -> weak
  > Turn back -> leave

  [weak]
  !macro Boss Disadvantage
  !enter

  [enter]
  !macro Boss Intro
  !enter

  [leave]
  You tremble away from the threshold... for now.
  !stay
  ```

  | Line | Meaning |
  |---|---|
  | `[name]` | starts a node; text before the first one belongs to `[start]` |
  | text | a page; a blank line or `---` starts the next page |
  | `> Label -> node` | a choice, shown with the node's last page |
  | `> Label [check] -> node` | a choice offered only if the check passes |
  | `-> node` | jump |
  | `!if check -> node` | jump if the check passes, otherwise carry on |
  | `!macro Name` | run a macro (name or UUID); it gets `actor`, `token`, `region`, `behavior`, `tile`, `node`, `party` |
  | `!enter` (or `!done`) / `!stay` | end in success (let the token in) / end without (keep it out); a node that just ends counts as `!stay` |
  | `// …` | comment |

  **Text.** Inside any page or choice label:

  | Markup | Result |
  |---|---|
  | `{red}…{/}` | colour: red, blue, green, yellow, orange, purple, pink, cyan, gray, white, black, gold, teal, brown, or `{#3cf}` / `{#e0b030}` |
  | `{b}` `{i}` `{u}` `{big}` `{small}` | bold, italic, underline, larger, smaller |
  | `{flash1}` `{flash2}` `{flash3}` | colour flashing: red/yellow, cyan/blue, green/light green |
  | `{glow1}` `{glow2}` `{glow3}` | colour cycling: red→yellow→green→cyan, red→purple→blue, gray→green→cyan |
  | `{rainbow}` | every letter cycles through the rainbow, one after another |
  | `{wave}` `{wave2}` | letters bob up and down in a wave (`wave2` also sways sideways) |
  | `{shake}` / `{jitter}` | the whole text trembles / each letter jitters on its own |
  | `{pulse}` | grows and shrinks |
  | `{scroll}` | scrolls across the box, right to left, on its own line |
  | `{slide}` / `{fade}` | slides down into place / fades in, once |
  | `{type}` | typewriter: letters appear one at a time |

  `{/}` closes the latest effect; anything still open closes at the end of the page. Effects
  combine, e.g. `{type}{wave}{red}It's coming…{/}{/}{/}` types out red, waving text. Motion
  stops for players whose system asks for reduced motion.
  | `{trainer}` `{pokemon}` `{lead}` `{actor}` `{user}` | the trainer, the token's Pokémon (or the party's first), the token's actor, the player |
  | `{flag:x}` `{actor:x}` `{world:x}` | a memory flag's value |
  | `@Name` / `@Name: text` / `@` | show "**Name:**" before the following pages / just this line onwards / stop |

  **Commands.** Most take an optional `-> success | failure`: the dialogue jumps to the first
  node on success, the second on failure, and carries on with the next line when that side is
  left out (`-> | broke` only branches on failure).

  | Command | Does | Succeeds when |
  |---|---|---|
  | `!portrait Pika` / `!portrait lead` / `!portrait pics/oak.webp` / `!portrait off` | the framed portrait window (as for field moves) beside the text box until changed, turned off, or the dialogue ends | it opened |
  | `!sound sfx/door.ogg` | plays a sound for this player (DGA's Interact volume) | always |
  | `!cry` / `!cry Pika` | plays a Pokémon's cry (Pokémon Assets); no name = the token's Pokémon | it played |
  | `!roll athletics 15` | a real PTR skill check (chat card, modifiers, rule elements) against the DC; who rolls: `token` (default), `best` (highest rank in the party), `choose` (the player picks) | total ≥ DC |
  | `!chance 30` | random, out of 100 | the roll is under 30 |
  | `!pay 500` / `!earn 500` | takes / gives the trainer's money | there was enough |
  | `!take "Old Key"` / `!take potion 2` | uses up owned items (by name, slug or UUID; deletes at 0) | the party had enough |
  | `!give "Super Potion" 2` | gives the trainer an item (world item, compendium item by name, or UUID), stacking with one they have | it was found |
  | `!set talked-to-elder` / `!set actor:petted 2` / `!set world:bridge-repaired` | stores a memory flag (true, a number, or a word) | it was saved |
  | `!add badges-shown 1` / `!clear talked-to-elder` | adds to a number flag / removes a flag | it was saved |
  | `!ask-gm "May they enter?"` | asks the GM; they get a Yes/No window | the GM said yes |

  Names with spaces go in quotes. Rolls, costs and items use the party below; money and new
  items go to the trainer. Players need to own the trainer for money and items.

  **Checks** are PTR predicates tested against the whole party: the token's actor, its
  trainer, and the trainer's unboxed Pokémon. Write `a, b` for both, `a | b` for either,
  `not a`, or a JSON predicate. Available:

  | Check | Meaning |
  |---|---|
  | the party's PTR roll options | anything PTR puts on the actors, e.g. `condition:fainted` |
  | `item:<slug>` | someone owns the item, e.g. `item:rising-badge` |
  | `species:<slug>`, `self:level:40+` | a Pokémon of that species / at least that level |
  | `trainer:level:10+`, `party:size:3+` | the trainer's level / number of Pokémon |
  | `skill:athletics:adept+` | someone has that rank (pathetic … virtuoso, or a number); skills by name, e.g. `skill:pokemon-education:expert+` |
  | `flag:x`, `flag:x:3`, `flag:x:2+` | party memory: set / has that value / at least |
  | `actor:x…`, `world:x…` | actor and world memory, the same way |
  | `combat:active`, `combat:round:3+` | combat state |
  | `scene:victory-road` | the scene being viewed |
  | `time:day` / `time:night` (6:00–18:00 is day), `time:hour:20+`, `season:winter` | from Simple Calendar, or Foundry's clock without it |
  | `user:gm` | the GM is the one talking |

  **Memory flags** aren't tied to a scene: one set in one scene can be checked by any
  dialogue in any other.
  - **Party** (`!set x`): stored on the trainer, shared by their Pokémon. The default.
  - **Actor** (`!set actor:x`): stored on the actor talking.
  - **World** (`!set world:x`): shared by everyone. Players' world writes go through the GM's
    client, so a GM must be connected. `!ask-gm` needs one too.

  The GM can manage memory from the console with
  `game.modules.get("PTRe1-Adjustment-Modules").api.dialogues.memory`:
  - `list("Red")` shows world, party and actor flags for Red.
  - `set("talked-to-elder", true, "Red")` sets a party flag for Red's party.
  - `set("world:bridge-repaired")` sets a world flag.
  - `clear("actor:petted", "Pika")` removes a flag.
  - `wipe("world" | "actors" | "all")` clears memory in bulk.

  *Ask again* (regions and tiles) picks whether a dialogue that ended in `!enter`/`!done` plays
  again: every time, once per token, or once per actor.
  `game.modules.get("PTRe1-Adjustment-Modules").api.dialogues.reset()` makes everyone answer
  again. On regions, GM moves aren't blocked and don't start Walking-in dialogues unless *Ask
  the GM too* is on; pressing Interact always works. The world must be relaunched once so
  Foundry picks up the new behavior type and the module's socket (used for world flags and
  `!ask-gm`).

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
- System: `ptu` (PTR release line, `4.4.3.57` or later)
- Optional: Dylan's General Automations **1.0.8+** and Pokémon Assets 1.0.8+ for the
  Pokémon Assets / DGA fixes
- [libWrapper](https://github.com/ruipin/fvtt-lib-wrapper) (declared as a required dependency)

## Install

In Foundry → **Add-on Modules → Install Module**, paste the manifest URL:

```
https://github.com/HeadMaidTypeX-2/PTRe1-Adjustment-Modules/releases/latest/download/module.json
```