/**
 * Automated Animations — ChatMessage#user shim
 * --------------------------------------------
 * Foundry V14 removed ChatMessage#user (deprecated since V12) in favour of
 * ChatMessage#author, and dropped the backwards-compatible shim. Automated
 * Animations' PTU handler (src/system-support/aa-ptu.js) still reads
 * `msg.user.id`, so msg.user is now undefined, `.id` throws a TypeError inside
 * the createChatMessage hook, the callback aborts, and the animation never
 * plays. This re-adds `user` as a getter alias for `author`, which fixes that
 * handler — and any other handler / module still using the old name.
 *
 * On Foundry V13 (or anywhere `user` still exists) this is a harmless no-op.
 */

Hooks.once("setup", () => {
  const cls =
    CONFIG.ChatMessage?.documentClass ??
    foundry?.documents?.ChatMessage ??
    globalThis.ChatMessage;

  if (!cls?.prototype) {
    console.error("PTU Table Toolkit | AA shim: could not locate the ChatMessage class.");
    return;
  }

  if (Object.getOwnPropertyDescriptor(cls.prototype, "user")) {
    console.log("PTU Table Toolkit | AA shim: ChatMessage#user already exists; leaving it untouched.");
    return;
  }

  Object.defineProperty(cls.prototype, "user", {
    get() { return this.author; },
    configurable: true,
  });

  console.log("PTU Table Toolkit | AA shim: restored ChatMessage#user as an alias of #author.");
});
