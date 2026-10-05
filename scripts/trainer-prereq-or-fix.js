/**
 * Trainer Level-Up — OR prerequisites (ptu 4.4.3.46)
 * ----------------------------------------------------------------------------
 * The Trainer Level-Up wizard filters features/edges through
 * `checkSinglePrereq` (src/util/prereq-checker.js). It tries every
 * single-condition pattern (Level N, <Rank> <Skill>, "N of …") against the
 * WHOLE string before its OR branch, so the first pattern that matches decides
 * the result and the other alternatives are never tested:
 *
 *   "Adept Guile or Stealth"                 -> "Stealth" tested as an item name
 *   "Level 10 or Two of … at Adept Rank"     -> level only (Tutelage & co.)
 *   "Novice Athletics or One of … Swimmer"   -> feature list only (Athlete)
 *
 * Data typos the checker cannot read at all (never met, even at Virtuoso):
 *   "Adept General\nEducation or …"          Seed Bag Rank 1
 *   "Two of Charm Intimidate Intuition or …" Mentoring, Tutelage & co.
 *   "Novice Survial"                         Hunter (Class Rework)
 *   "Expert Athletics And Focus"             Enduring Soul, Vim and Vigour,
 *                                            Stat Stratagem, Mystic
 *   "Novice Acrobatics; Athletics or Charm"  Dancer, Choreographer, Power Pirouette
 *   "Adept Technology Ed"                    The Devil's Playthings
 *   ["Adept Intuition and …", "or Mystic Senses"]   Mystic (OR across entries)
 *
 * `checkSinglePrereq` is module-private, so it cannot be replaced. Instead this
 * wraps the three list getters. An entry starting with "or" is joined to the
 * one before it. Each prerequisite is normalised, split into AND groups on
 * ";", each group into OR options (keeping "N of … at Rank" and "N of A or B"
 * lists whole), and each option into AND terms on "and" when every part is a
 * skill. A leading
 * rank carries to bare skill terms, a skill name one letter off after a rank
 * is corrected, and every term is tested with the system's own
 * `meetsPrereqsWithContext`. For the duration of the call the entry's label is
 * swapped for a pass/fail stand-in; returned entries get their original
 * prerequisites back, so the window shows PTR's text. Compendium browser data
 * is never mutated.
 *
 * "Adept in 2 Rogue Skills" (Street Brawler, Class Rework) refers to a class's
 * skills: the ones in that class feature's own prerequisite (Rogue: "Two of
 * Acrobatics or Athletics or Stealth at Novice"). The list is read from the
 * loaded class feature, never hardcoded, and the term becomes
 * "2 of Acrobatics or Athletics or Stealth at Adept".
 *
 * Also fixes the class gate for multi-word Class Rework classes (Glamour
 * Weaver -> Fey Law): see augmentContext().
 *
 * Remove once upstream splits OR before pattern-matching in checkSinglePrereq,
 * matches classes by sluggified name, and the pack typos are fixed.
 */

import { featureEnabled } from "./feature-toggles.js";

const MODULE_ID = "PTRe1-Adjustment-Modules";
const RANKS = "Pathetic|Untrained|Novice|Adept|Expert|Master|Virtuoso";
const RANK_RE = new RegExp(`\\b(${RANKS})\\b`, "i");
const N_WORD = "[0-9]+|A|One|Two|Three|Four|Five|Six|Seven|Eight|Nine";
const N_OF_START_RE = new RegExp(`^(?:[A-Z]:\\s*)?(?:${N_WORD}) of\\b`, "i");
const AT_RANK_RE = new RegExp(` at (?:${RANKS})\\b`, "i");
const SKILL_LIST_RE = new RegExp(`\\b((?:${N_WORD}) of )(.+?)( at (?:${RANKS})\\b)`, "i");

/** Labels the system checker always passes / always fails. */
const PASS = "";
const FAIL = "ptre-unmet";

const RANKED_RE = new RegExp(`^((?:[A-Z]:\\s*)?(?:${RANKS}) )(.+)$`, "i");
/** "Adept in 2 Rogue Skills" — the class feature's own prerequisite skills. */
const CLASS_SKILLS_RE = new RegExp(`^(${RANKS}) in (${N_WORD}) (.+?) Skills$`, "i");

/** simplified class name -> skill names from its "N of A or B at Rank" prerequisite. */
let classSkills = new Map();
let classSkillsSource = null;

let simplifyString = (s) => s?.toLowerCase();
let meetsPrereqsWithContext = null;
let buildActorPrereqContext = null;
let sluggify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function skillLabels() {
  return CONFIG.PTU.data.skills.keys.map((k) => game.i18n.format(`SKILL.${k}`));
}

/** Same resolution as prereq-checker.js getSkillKey. */
function isSkillName(name) {
  const target = simplifyString(name.replace(/\.$/, "").trim());
  return !!target && skillLabels().some((label) => target === simplifyString(label));
}

/** True when a and b differ by exactly one insertion, deletion or substitution. */
function oneEditApart(a, b) {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/** "Survial" -> "Survival" when exactly one skill name is one edit away. */
function correctSkill(name) {
  const target = simplifyString(name.replace(/\.$/, "").trim());
  if (!target || target.length < 4) return null;
  const hits = skillLabels().filter((label) => oneEditApart(target, simplifyString(label)));
  return hits.length === 1 ? hits[0] : null;
}

/**
 * "Charm Intimidate Intuition or Pokémon Education" -> skill names joined by
 * " or ". Greedy longest match over words; returns null unless every word is
 * consumed by a skill name (ignoring "or", "and" and commas).
 */
function splitSkillRun(list) {
  const words = list.replace(/,/g, " ").split(/\s+/).filter((w) => w && !/^(or|and)$/i.test(w));
  const skills = [];
  for (let i = 0; i < words.length;) {
    let len = Math.min(3, words.length - i);
    while (len > 0 && !isSkillName(words.slice(i, i + len).join(" "))) len--;
    if (!len) return null;
    skills.push(words.slice(i, i + len).join(" "));
    i += len;
  }
  return skills.length ? skills.join(" or ") : null;
}

/** Collapse whitespace, drop "or higher", expand "Ed", repair unseparated skill lists. */
function normalise(text) {
  let out = text.replace(/\s+/g, " ").replace(/ or higher\b/gi, "").replace(/\bEd\b\.?/g, "Education").trim();
  out = out.replace(SKILL_LIST_RE, (whole, head, list, tail) => {
    const fixed = splitSkillRun(list);
    return fixed ? `${head}${fixed}${tail}` : whole;
  });
  return out;
}

/** Split on top-level " or ", keeping "N of …" lists whole. */
function splitOptions(text) {
  const terms = text.split(/ or /i);
  const options = [];
  for (let i = 0; i < terms.length; i++) {
    let term = terms[i];
    if (N_OF_START_RE.test(term.trim())) {
      // Skill list: absorb up to the term carrying " at <Rank>".
      // Feature list: no rank anywhere after, absorb to the end.
      const rest = terms.slice(i);
      const end = rest.findIndex((t) => AT_RANK_RE.test(t));
      const take = end >= 0 ? end + 1 : rest.length;
      term = rest.slice(0, take).join(" or ");
      i += take - 1;
    }
    options.push(term.trim());
  }
  return options;
}

/**
 * "Expert Athletics And Focus" -> AND terms.
 * Only when the first part is ranked and every part is a skill, so feature
 * names containing "and" ("Vim and Vigour") are never split.
 */
function splitAnd(option) {
  if (N_OF_START_RE.test(option)) return [option];
  const parts = option.split(/ and /i).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return [option];
  const allSkills = parts.every((part, i) => {
    const ranked = part.match(RANKED_RE);
    if (!ranked) return i > 0 && isSkillName(part);
    return isSkillName(ranked[2]) || !!correctSkill(ranked[2]);
  });
  return allSkills ? parts : [option];
}

/**
 * In reading order: carry a leading rank to bare skill terms ("Adept Guile or
 * Stealth") and correct a misspelled skill directly after a rank ("Novice Survial").
 */
function finishTerms(groups) {
  let rank = null;
  return groups.map((options) => options.map((terms) => terms.map((term) => {
    const own = term.match(RANK_RE);
    if (own) {
      rank = own[1];
      const ranked = term.match(RANKED_RE);
      if (ranked && !isSkillName(ranked[2])) {
        const fixed = correctSkill(ranked[2]);
        if (fixed) return `${ranked[1]}${fixed}`;
      }
      return term;
    }
    return rank && isSkillName(term) ? `${rank} ${term}` : term;
  })));
}

function classKey(name) {
  return simplifyString(String(name ?? "").trim())?.replace(/\s+/g, "-");
}

/**
 * Class name -> skills, read from each "Class" feature's own
 * "N of A or B at Rank" prerequisite. Rebuilt when the feature list changes.
 */
function loadClassSkills(features) {
  if (!Array.isArray(features) || features === classSkillsSource) return;
  classSkillsSource = features;
  classSkills = new Map();
  parsed.clear();
  for (const entry of features) {
    if (!entry?.keywords?.includes("Class")) continue;
    for (const p of entry.prerequisites ?? []) {
      const list = normalise(p?.label ?? "").match(SKILL_LIST_RE)?.[2];
      const skills = list?.split(/ or /i).map((s) => s.trim()).filter(Boolean);
      if (skills?.length && skills.every(isSkillName)) {
        classSkills.set(classKey(entry.classPretty || entry.name), skills);
      }
    }
  }
}

/** "Adept in 2 Rogue Skills" -> "2 of Acrobatics or Athletics or Stealth at Adept". */
function expandClassSkills(part) {
  const match = part.match(CLASS_SKILLS_RE);
  const skills = match && classSkills.get(classKey(match[3]));
  return skills ? `${match[2]} of ${skills.join(" or ")} at ${match[1]}` : part;
}

/**
 * label -> AND groups (";") of OR options of AND terms ("and"), or null when
 * the system's own check of the label is already right.
 */
const parsed = new Map();
function optionsFor(label) {
  if (typeof label !== "string") return null;
  if (parsed.has(label)) return parsed.get(label);
  const text = normalise(label);
  const groups = finishTerms(
    text.split(/;\s*/).filter(Boolean).map(expandClassSkills).map((part) =>
      (/ or /i.test(part) ? splitOptions(part) : [part]).map(splitAnd))
  );
  const unchanged = groups.length === 1 && groups[0].length === 1
    && groups[0][0].length === 1 && groups[0][0][0] === label;
  const result = unchanged ? null : groups;
  parsed.set(label, result);
  return result;
}

function termMet(term, ctx) {
  return meetsPrereqsWithContext({ prerequisites: [{ label: term }] }, ctx);
}

function labelMet(groups, ctx) {
  return groups.every((options) => options.some((terms) => terms.every((t) => termMet(t, ctx))));
}

/** Copy of `entries` with every repaired prerequisite pre-resolved for this actor. */
function resolveEntries(entries, ctx, originals) {
  if (!Array.isArray(entries)) return entries;
  return entries.map((entry) => {
    const prereqs = entry?.prerequisites;
    if (!Array.isArray(prereqs) || !prereqs.length) return entry;
    let changed = false;
    const next = [];
    for (let i = 0; i < prereqs.length; i++) {
      // ["Adept Intuition and …", "or Mystic Senses"]: a leading "or" joins the entry before it.
      let label = prereqs[i]?.label;
      let j = i;
      while (typeof label === "string" && /^\s*or\s/i.test(prereqs[j + 1]?.label ?? "")) {
        j++;
        label = `${label} ${prereqs[j].label.trim()}`;
      }
      const groups = optionsFor(label);
      if (!groups) {
        next.push(prereqs[i]);
        continue;
      }
      changed = true;
      next.push({ ...prereqs[i], label: labelMet(groups, ctx) ? PASS : FAIL });
      for (let k = i + 1; k <= j; k++) next.push({ ...prereqs[k], label: PASS });
      i = j;
    }
    if (!changed) return entry;
    if (entry.uuid) originals.set(entry.uuid, prereqs);
    return { ...entry, prerequisites: next };
  });
}

/**
 * The class gate (`meetsPrereqsWithContext`) tests the sluggified class name
 * ("glamour-weaver") against owned item names, stored lowercase with spaces,
 * and slugs ("glamour-weaver-cr" on the Class Rework item). Multi-word Class
 * Rework classes therefore never match. Add each owned item's sluggified name
 * and its `replacesSlug` to the slug set.
 */
function augmentContext(ctx, actor) {
  for (const item of actor?.items?.contents ?? []) {
    if (item?.name) ctx.itemSlugs.add(sluggify(item.name));
    const replaces = item?.system?.replacesSlug;
    if (replaces) ctx.itemSlugs.add(String(replaces).toLowerCase());
  }
  return ctx;
}

function wrapScoreContext(proto) {
  const original = proto._getActorScoreContext;
  if (typeof original !== "function") return false;
  proto._getActorScoreContext = function (...args) {
    const result = original.apply(this, args);
    try {
      if (result?.prereqCtx?.itemSlugs) augmentContext(result.prereqCtx, this.actor);
    } catch (error) {
      console.error(`${MODULE_ID} | class-gate context failed`, error);
    }
    return result;
  };
  return true;
}

function wrapGetter(proto, name) {
  const original = proto[name];
  if (typeof original !== "function") return false;
  proto[name] = function (...args) {
    let ctx;
    try {
      loadClassSkills(this._compendiumFeatures);
      ctx = augmentContext(buildActorPrereqContext(this.actor), this.actor);
    } catch (error) {
      console.error(`${MODULE_ID} | OR-prerequisite context failed`, error);
      return original.apply(this, args);
    }
    const features = this._compendiumFeatures;
    const edges = this._compendiumEdges;
    const originals = new Map();
    try {
      this._compendiumFeatures = resolveEntries(features, ctx, originals);
      this._compendiumEdges = resolveEntries(edges, ctx, originals);
      const result = original.apply(this, args);
      if (!Array.isArray(result)) return result;
      return result.map((item) =>
        originals.has(item?.uuid) ? { ...item, prerequisites: originals.get(item.uuid) } : item
      );
    } finally {
      this._compendiumFeatures = features;
      this._compendiumEdges = edges;
    }
  };
  return true;
}

Hooks.once("setup", async () => {
  if (game.system.id !== "ptu" || !featureEnabled("trainerPrereqOr")) return;
  try {
    ({ simplifyString, meetsPrereqsWithContext, buildActorPrereqContext } =
      await import("/systems/ptu/src/util/prereq-checker.js"));
    ({ sluggify } = await import("/systems/ptu/src/util/misc.js"));
    const { TrainerLevelUpData } = await import("/systems/ptu/src/module/apps/trainer-level-up/document.js");
    const proto = TrainerLevelUpData?.prototype;
    if (!proto || proto.ptreOrPrereqPatched) return;

    const wrapped = ["getAvailableFeatures", "getAvailableEdges", "getBonusOptionItems"]
      .filter((name) => wrapGetter(proto, name));
    if (wrapScoreContext(proto)) wrapped.push("_getActorScoreContext");
    proto.ptreOrPrereqPatched = true;
    console.log(`${MODULE_ID} | trainer OR-prerequisite fix installed (${wrapped.join(", ")}).`);
  } catch (error) {
    console.error(`${MODULE_ID} | could not patch TrainerLevelUpData; OR-prerequisite fix NOT installed.`, error);
  }
});

export { normalise, optionsFor };
