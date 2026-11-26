/**
 * Unlinked attackers — chat message actor / item lookup
 * -----------------------------------------------------
 * PTR's ChatMessagePTU resolves the attacker with `/^Actor\.(\w+)$/` against
 * `flags.ptu.attack.actor` (message/base.js:13), and the item with
 * `/^Actor\.(\w+)\.Item\.(\w+)$/` against `flags.ptu.context.item` (:77).
 * An unlinked token's actor UUID is `Scene.<s>.Token.<t>.Actor.<a>`, so both
 * return null. With `message.item` null, Apply Damage throws in `applyIWR`
 * ("can't access property 'system', item is null", actor/base.js:1116), and
 * origin-side effects, drain and recoil lose their attacker.
 *
 * This wraps the two getters: when PTR's own lookup returns null, the stored
 * UUID is resolved with fromUuidSync (synthetic actors included). If the token
 * is gone, it falls back to the world actor with the same id, so the move's
 * type and category are still available.
 */

import { featureEnabled } from "./feature-toggles.js";

const resolveActor = (uuid) => {
  if (typeof uuid !== "string" || !uuid) return null;
  const doc = fromUuidSync(uuid, { strict: false });
  if (doc instanceof Actor) return doc;
  const id = /Actor\.(\w+)$/.exec(uuid)?.[1];
  return id ? game.actors.get(id) ?? null : null;
};

const resolveItem = (uuid) => {
  if (typeof uuid !== "string" || !uuid) return null;
  const doc = fromUuidSync(uuid, { strict: false });
  if (doc instanceof Item) return doc;
  const m = /Actor\.(\w+)\.Item\.(\w+)$/.exec(uuid);
  return m ? game.actors.get(m[1])?.items.get(m[2]) ?? null : null;
};

Hooks.once("setup", async () => {
  let ChatMessagePTU;
  try {
    ({ ChatMessagePTU } = await import("/systems/ptu/src/module/message/base.js"));
  } catch (err) {
    console.error("PTRe1 | unlinked-attacker-fix: could not import ChatMessagePTU.", err);
    return;
  }
  const proto = ChatMessagePTU?.prototype;
  const actorDesc = proto && Object.getOwnPropertyDescriptor(proto, "actor");
  const itemDesc = proto && Object.getOwnPropertyDescriptor(proto, "item");
  if (!actorDesc?.get || !itemDesc?.get) {
    console.error("PTRe1 | unlinked-attacker-fix: ChatMessagePTU getters not found; PTR changed.");
    return;
  }

  Object.defineProperty(proto, "actor", {
    configurable: true,
    get() {
      const actor = actorDesc.get.call(this);
      if (actor || !featureEnabled("unlinkedAttacker")) return actor;
      return resolveActor(this.flags?.ptu?.attack?.actor);
    },
  });

  Object.defineProperty(proto, "item", {
    configurable: true,
    get() {
      const item = itemDesc.get.call(this);
      if (item || !featureEnabled("unlinkedAttacker")) return item;
      return resolveItem(this.flags?.ptu?.context?.item);
    },
  });
});
