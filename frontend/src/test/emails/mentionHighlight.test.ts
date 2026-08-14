// The mirror layer paints whatever these runs say, so a wrong split shows up as
// the wrong words turning blue.
import { describe, expect, it } from "vitest";

import { splitMentions } from "../../emails/mentionHighlight";

/** The concatenated runs must always reconstruct the input exactly, or the
 *  mirror would drift out of alignment with the textarea behind it. */
function rejoin(text: string): string {
  return splitMentions(text)
    .map((r) => r.text)
    .join("");
}

const mentionsIn = (text: string) =>
  splitMentions(text)
    .filter((r) => r.mention)
    .map((r) => r.text);

describe("splitMentions", () => {
  it("returns one plain run for text with no mention", () => {
    expect(splitMentions("just a note")).toEqual([
      { text: "just a note", mention: false },
    ]);
  });

  it("returns nothing for empty text", () => {
    expect(splitMentions("")).toEqual([]);
  });

  it("picks out a mention mid-sentence, keeping the space outside it", () => {
    expect(splitMentions("cc @ada@corp.test please")).toEqual([
      { text: "cc ", mention: false },
      { text: "@ada@corp.test", mention: true },
      { text: " please", mention: false },
    ]);
  });

  it("picks out a mention at the very start", () => {
    expect(splitMentions("@ada@corp.test hi")).toEqual([
      { text: "@ada@corp.test", mention: true },
      { text: " hi", mention: false },
    ]);
  });

  it("handles several mentions in one message", () => {
    expect(mentionsIn("@a@x.test and @b@y.test")).toEqual([
      "@a@x.test",
      "@b@y.test",
    ]);
  });

  it("covers the address forms the picker can insert", () => {
    expect(mentionsIn("@ada+news@corp.test")).toEqual(["@ada+news@corp.test"]);
    expect(
      mentionsIn("@bounce+9e20b4.e6d86c-x=gmail.com@mg.nityo.com")
    ).toEqual(["@bounce+9e20b4.e6d86c-x=gmail.com@mg.nityo.com"]);
  });

  it("leaves a plain address alone — it is not a mention", () => {
    // Same rule as the picker: the @ has to start the line or follow a space.
    expect(mentionsIn("mail ada@corp.test")).toEqual([]);
  });

  it("treats a newline as a boundary, so a mention on its own line counts", () => {
    expect(mentionsIn("Thanks,\n@ada@corp.test")).toEqual(["@ada@corp.test"]);
  });

  it("reconstructs the input exactly, whatever the shape", () => {
    for (const text of [
      "",
      "plain",
      "@a@x.test",
      "cc @a@x.test and @b@y.test, thanks",
      "trailing space @a@x.test ",
      "line\n\n@a@x.test\nmore",
      "mail ada@corp.test",
    ]) {
      expect(rejoin(text)).toBe(text);
    }
  });
});
