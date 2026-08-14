// `activeMention` decides whether the contact picker is armed and, if so, what
// the query is. It is shared by the chat composer (handles) and the email reply
// composer (addresses), so both modes are pinned here — the email mode is the
// fix, the default mode is the regression guard for chat.
import { describe, expect, it } from "vitest";

import { activeMention } from "../../shared/mentions";

const ADDRESS = { allowAddress: true } as const;

// The exact bounce address from the bug report: a plus-tag, dots, a dash, and
// the `=` that bounce mailboxes use to fold the original address in.
const BOUNCE = "bounce+9e20b4.e6d86c-maheshpy85=gmail.com@mg.nityo.com";

describe("activeMention — default (chat handles)", () => {
  it("matches a plain handle after whitespace", () => {
    expect(activeMention("hey @ali", 8)).toEqual({ query: "ali", start: 4 });
  });

  it("allows dots and dashes, and matches at the start of the line", () => {
    expect(activeMention("@a.b-c", 6)).toEqual({ query: "a.b-c", start: 0 });
  });

  it("ignores a mid-word @, so a written-out address never arms it", () => {
    expect(activeMention("x@ali", 5)).toBeNull();
  });

  it("stops at a second @ — a chat handle can never contain one", () => {
    // This is the behaviour the email composer needed changed, so it is worth
    // stating outright that chat keeps it.
    expect(activeMention("hey @ali@corp.com", 17)).toBeNull();
  });
});

describe("activeMention — allowAddress (email reply composer)", () => {
  it("still matches a plain handle", () => {
    expect(activeMention("hey @ali", 8, ADDRESS)).toEqual({
      query: "ali",
      start: 4,
    });
  });

  it("matches a full email address — the reported bug", () => {
    expect(activeMention("hey @ali@corp.com", 17, ADDRESS)).toEqual({
      query: "ali@corp.com",
      start: 4,
    });
  });

  it("matches a plus-tagged address", () => {
    expect(activeMention("@ali+news@corp.com", 18, ADDRESS)).toEqual({
      query: "ali+news@corp.com",
      start: 0,
    });
  });

  it("matches a bounce address, = and all", () => {
    const text = `@${BOUNCE}`;
    expect(activeMention(text, text.length, ADDRESS)).toEqual({
      query: BOUNCE,
      start: 0,
    });
  });

  it("stays armed on the trailing @ while the domain is still being typed", () => {
    expect(activeMention("@maheshy85@", 11, ADDRESS)).toEqual({
      query: "maheshy85@",
      start: 0,
    });
  });

  it("does not swallow text typed after the address", () => {
    expect(activeMention("@ali@corp.com thanks", 20, ADDRESS)).toBeNull();
  });

  it("does not arm on an address written out normally", () => {
    expect(activeMention("mail ada@corp.com", 17, ADDRESS)).toBeNull();
  });

  it("anchors on the caret's own @, not an earlier address in the body", () => {
    // `start` is what apply() splices on, so an off-by-one here would eat the
    // wrong span of the message.
    expect(activeMention("cc ada@corp.com and @bo", 23, ADDRESS)).toEqual({
      query: "bo",
      start: 20,
    });
  });

  it("closes once the mention is finished with a space", () => {
    expect(activeMention("@ali@corp.com ", 14, ADDRESS)).toBeNull();
  });
});
