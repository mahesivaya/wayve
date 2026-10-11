// Who Reply addresses: the sender, or — when the message is your own (often the
// newest message of a conversation) — its recipients, never yourself.
import { describe, expect, it } from "vitest";
import { replyRecipients } from "../../emails/replyRecipients";

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
