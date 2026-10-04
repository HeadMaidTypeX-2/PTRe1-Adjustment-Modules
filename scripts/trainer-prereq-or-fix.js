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
 * Two data typos break it further: "Adept General\nEducation or Adept Survival"
 * (Seed Bag Rank 1) and "Two of Charm Intimidate Intuition or …" (Mentoring,
 * Tutelage, Limit Breaking, Honed Potential).
 *
 * `checkSinglePrereq` is module-private, so it cannot be replaced. Instead this
 * wraps the three list getters. For each prerequisite containing a top-level
 * OR it normalises the text, splits it into options (keeping "N of … at Rank"
 * and "N of A or B" lists whole), carries a leading rank to bare skill terms,
 * and tests each option with the system's own `meetsPrereqsWithContext`. For
 * the duration of the call the entry's label is swapped for a pass/fail
 * stand-in; returned entries get their original prerequisites back, so the
 * window shows PTR's text. Compendium browser data is never mutated.
 *
 * Remove once upstream splits OR before pattern-matching in checkSinglePrereq.
 */

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

let simplifyString = (s) => s?.toLowerCase();
let meetsPrereqsWithContext = null;
let buildActorPrereqContext = null;

/** Same resolution as prereq-checker.js getSkillKey. */
function isSkillName(name) {
  const target = simplifyString(name.replace(/\.$/, "").trim());
  return !!target && CONFIG.PTU.data.skills.keys.some(
    (k) => target === simplifyString(game.i18n.format(`SKILL.${k}`))
  );
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

/** Collapse whitespace, drop "or higher", repair unseparated skill lists. */
function normalise(text) {
  let out = text.replace(/\s+/g, " ").replace(/ or higher\b/gi, "").trim();
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
  // Carry a leading rank to bare skill terms: "Adept Guile or Stealth".
  let rank = null;
  return options.map((opt) => {
    const own = opt.match(RANK_RE);
    if (own) {
      rank = own[1];
      return opt;
    }
    return rank && isSkillName(opt) ? `${rank} ${opt}` : opt;
  });
}

/** label -> option list, or null when the system's own check is fine. */
const parsed = new Map();
function optionsFor(label) {
  if (typeof label !== "string") return null;
  if (parsed.has(label)) return parsed.get(label);
  let result = null;
  const text = normalise(label);
  if (/ or /i.test(text)) {
    const options = splitOptions(text);
    if (options.length > 1 || text !== label) result = options;
  } else if (text !== label) {
    result = [text];
  }
  parsed.set(label, result);
  return result;
}

function optionMet(option, ctx) {
  return meetsPrereqsWithContext({ prerequisites: [{ label: option }] }, ctx);
}

/** Copy of `entries` with every OR prerequisite pre-resolved for this actor. */
function resolveEntries(entries, ctx, originals) {
  if (!Array.isArray(entries)) return entries;
  return entries.map((entry) => {
    const prereqs = entry?.prerequisites;
    if (!Array.isArray(prereqs) || !prereqs.length) return entry;
    let changed = false;
    const next = prereqs.map((p) => {
      const options = optionsFor(p?.label);
      if (!options) return p;
      changed = true;
      return { ...p, label: options.some((o) => optionMet(o, ctx)) ? PASS : FAIL };
    });
    if (!changed) return entry;
    if (entry.uuid) originals.set(entry.uuid, prereqs);
    return { ...entry, prerequisites: next };
  });
}

function wrapGetter(proto, name) {
  const original = proto[name];
  if (typeof original !== "function") return false;
  proto[name] = function (...args) {
    let ctx;
    try {
      ctx = buildActorPrereqContext(this.actor);
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
  if (game.system.id !== "ptu") return;
  try {
    ({ simplifyString, meetsPrereqsWithContext, buildActorPrereqContext } =
      await import("/systems/ptu/src/util/prereq-checker.js"));
    const { TrainerLevelUpData } = await import("/systems/ptu/src/module/apps/trainer-level-up/document.js");
    const proto = TrainerLevelUpData?.prototype;
    if (!proto || proto.ptreOrPrereqPatched) return;

    const wrapped = ["getAvailableFeatures", "getAvailableEdges", "getBonusOptionItems"]
      .filter((name) => wrapGetter(proto, name));
    proto.ptreOrPrereqPatched = true;
    console.log(`${MODULE_ID} | trainer OR-prerequisite fix installed (${wrapped.join(", ")}).`);
  } catch (error) {
    console.error(`${MODULE_ID} | could not patch TrainerLevelUpData; OR-prerequisite fix NOT installed.`, error);
  }
});

export { normalise, splitOptions, optionsFor };
