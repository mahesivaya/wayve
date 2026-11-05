import { describe, expect, it } from "vitest";
import {
  channelsAlwaysPublic,
  usesStandardChatEncryption,
} from "../../chat/chatPolicy";

describe("chat policy", () => {
  it("makes organization and platform channels always public", () => {
    expect(channelsAlwaysPublic({ scope: "organization" })).toBe(true);
    expect(channelsAlwaysPublic({ scope: "platform" })).toBe(true);
    expect(channelsAlwaysPublic({ account_type: "organization_admin" })).toBe(
      true
    );
    expect(channelsAlwaysPublic({ scope: "personal" })).toBe(false);
    expect(channelsAlwaysPublic(null)).toBe(false);
  });

  it("uses standard encryption for organization and platform chat", () => {
    expect(usesStandardChatEncryption({ scope: "organization" })).toBe(true);
    expect(usesStandardChatEncryption({ scope: "platform" })).toBe(true);
    expect(usesStandardChatEncryption({ scope: "personal" })).toBe(false);
    expect(
      usesStandardChatEncryption({
        scope: "personal",
        current_plan: { tier: "enterprise" },
      })
    ).toBe(true);
  });
});
