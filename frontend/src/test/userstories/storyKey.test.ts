// A story's key is its project's first three letters or digits in capitals,
// then the story number padded to three digits; "NON" stands in for no project.
import { describe, expect, it } from "vitest";
import { storyKey } from "../../userstories/storyKey";

describe("storyKey", () => {
  it("joins the project's first three letters and the padded number", () => {
    expect(storyKey(4, "Sample One")).toBe("SAM004");
    expect(storyKey(42, "wayve")).toBe("WAY042");
  });

  it("uses NON when the story has no project", () => {
    expect(storyKey(1, "")).toBe("NON001");
    expect(storyKey(3, null)).toBe("NON003");
    expect(storyKey(3, undefined)).toBe("NON003");
  });

  it("skips spaces and punctuation in the project name", () => {
    expect(storyKey(7, "a-b c!")).toBe("ABC007");
    expect(storyKey(7, "---")).toBe("NON007");
  });

  it("keeps short names short and lets large numbers run longer", () => {
    expect(storyKey(5, "QA")).toBe("QA005");
    expect(storyKey(1000, "Sample")).toBe("SAM1000");
  });
});
