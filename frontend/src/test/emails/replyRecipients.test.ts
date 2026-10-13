// Who Reply addresses: the sender, or — when the message is your own (often the
// newest message of a conversation) — its recipients, never yourself. And when
// Reply all applies (more than one recipient across To and Cc) and whom it
// addresses.
import { describe, expect, it } from "vitest";
import {
  hasMultipleRecipients,
  replyAllRecipients,
  replyRecipients,
} from "../../emails/replyRecipients";

const me = ["me@x.com"];

describe("replyRecipients", () => {
  it("replies to the sender of someone else's message", () => {
    expect(
      replyRecipients({ sender: "Ada <ada@x.com>", receiver: "me@x.com" }, me)
    ).toEqual(["ada@x.com"]);
  });

  it("replies to the recipients of your own message, not to you", () => {
    expect(
      replyRecipients(
        { sender: "Me <ME@x.com>", receiver: "ada@x.com, Bo <bo@x.com>" },
        me
      )
    ).toEqual(["ada@x.com", "bo@x.com"]);
  });

  it("keeps a quoted display name containing a comma in one piece", () => {
    expect(
      replyRecipients(
        { sender: "me@x.com", receiver: '"Griffin, Peter" <peter@x.com>' },
        me
      )
    ).toEqual(["peter@x.com"]);
  });

  it("drops your own addresses and duplicates from the recipients", () => {
    expect(
      replyRecipients(
        {
          sender: "me@x.com",
          receiver: "ada@x.com, me@x.com, alt@x.com, ADA@x.com",
        },
        ["me@x.com", "alt@x.com"]
      )
    ).toEqual(["ada@x.com"]);
  });

  it("falls back to the sender when a note to yourself has no one else", () => {
    expect(
      replyRecipients({ sender: "me@x.com", receiver: "me@x.com" }, me)
    ).toEqual(["me@x.com"]);
  });
});

describe("hasMultipleRecipients", () => {
  it("is false for a message to one person", () => {
    expect(hasMultipleRecipients({ receiver: "Me <me@x.com>" })).toBe(false);
  });

  it("is true for more than one To recipient", () => {
    expect(
      hasMultipleRecipients({ receiver: '"Lee, Dan" <dan@x.com>, me@x.com' })
    ).toBe(true);
  });

  it("counts Cc recipients too", () => {
    expect(
      hasMultipleRecipients({ receiver: "me@x.com", cc: "carol@x.com" })
    ).toBe(true);
  });

  it("counts an address once, whatever its case or field", () => {
    expect(
      hasMultipleRecipients({ receiver: "me@x.com", cc: "ME@x.com" })
    ).toBe(false);
  });

  it("goes by To alone while the Cc is unknown", () => {
    expect(hasMultipleRecipients({ receiver: "me@x.com", cc: null })).toBe(
      false
    );
  });
});

describe("replyAllRecipients", () => {
  it("puts the sender and the other To recipients on To, the Cc on Cc", () => {
    expect(
      replyAllRecipients(
        {
          sender: "Ada <ada@x.com>",
          receiver: "me@x.com, Bo <bo@x.com>",
          cc: '"Lee, Dan" <dan@x.com>, carol@x.com',
        },
        me
      )
    ).toEqual({
      to: ["ada@x.com", "bo@x.com"],
      cc: ["dan@x.com", "carol@x.com"],
    });
  });

  it("leaves you out, even when you were on Cc", () => {
    expect(
      replyAllRecipients(
        { sender: "ada@x.com", receiver: "bo@x.com", cc: "Me <ME@x.com>" },
        me
      )
    ).toEqual({ to: ["ada@x.com", "bo@x.com"], cc: [] });
  });

  it("goes back to the people you wrote to, for your own message", () => {
    expect(
      replyAllRecipients(
        {
          sender: "me@x.com",
          receiver: "ada@x.com, bo@x.com",
          cc: "carol@x.com",
        },
        me
      )
    ).toEqual({ to: ["ada@x.com", "bo@x.com"], cc: ["carol@x.com"] });
  });

  it("lists an address once, on To first", () => {
    expect(
      replyAllRecipients(
        {
          sender: "ada@x.com",
          receiver: "me@x.com, ADA@x.com",
          cc: "ada@x.com",
        },
        me
      )
    ).toEqual({ to: ["ada@x.com"], cc: [] });
  });

  it("moves Cc up to To when no one else is on To", () => {
    expect(
      replyAllRecipients(
        { sender: "me@x.com", receiver: "me@x.com", cc: "carol@x.com" },
        me
      )
    ).toEqual({ to: ["carol@x.com"], cc: [] });
  });
});
