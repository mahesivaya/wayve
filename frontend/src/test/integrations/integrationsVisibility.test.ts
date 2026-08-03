// Who may see the Integrations page.
//
// Personal accounts keep it — Integrations.tsx is the ONLY place GmailPanel is
// rendered, so hiding it from them would remove their sole in-app way to
// connect a mailbox. Beyond that it is owner-only: an organization owner
// (enterprise is a plan tier, not a separate scope) or the platform owner.
// Non-owner members are bounced.
import { describe, expect, it } from "vitest";
import {
  canViewIntegrations,
  canViewIntegrationsNav,
} from "../../auth/permissions";

describe("canViewIntegrations", () => {
  it("lets personal accounts in — it is their only route to Gmail connect", () => {
    expect(canViewIntegrations({ scope: "personal" })).toBe(true);
    // Role is meaningless in personal scope; it must not gate them out.
    expect(
      canViewIntegrations({ scope: "personal", effective_role: "member" })
    ).toBe(true);
  });

  it("lets organization and platform OWNERS in", () => {
    expect(
      canViewIntegrations({ scope: "organization", effective_role: "owner" })
    ).toBe(true);
    expect(
      canViewIntegrations({ scope: "platform", effective_role: "owner" })
    ).toBe(true);
  });

  it("keeps every non-owner member out", () => {
    for (const role of [
      "super_admin",
      "admin",
      "security",
      "billing",
      "developer",
      "support",
      "member",
      "guest",
    ]) {
      expect(
        canViewIntegrations({ scope: "organization", effective_role: role }),
        `organization ${role} must not see Integrations`
      ).toBe(false);
      expect(
        canViewIntegrations({ scope: "platform", effective_role: role }),
        `platform ${role} must not see Integrations`
      ).toBe(false);
    }
  });

  it("falls back to account_type before scope resolves", () => {
    // account_type speaks a different vocabulary than scope: the *_admin
    // discriminators map onto the organization / platform scopes.
    expect(
      canViewIntegrations({
        account_type: "organization_admin",
        effective_role: "owner",
      })
    ).toBe(true);
    expect(
      canViewIntegrations({
        account_type: "platform_admin",
        effective_role: "owner",
      })
    ).toBe(true);
    expect(canViewIntegrations({ account_type: "personal" })).toBe(true);
    // An org founder's account_type with a non-owner role is still out.
    expect(
      canViewIntegrations({
        account_type: "organization",
        effective_role: "member",
      })
    ).toBe(false);
  });

  it("is closed by default for an unknown or absent user", () => {
    expect(canViewIntegrations(null)).toBe(false);
    expect(canViewIntegrations(undefined)).toBe(false);
    expect(canViewIntegrations({})).toBe(false);
  });
});

// The sidebar group is narrower than page access: personal accounts reach
// /integrations from the profile menu and Settings instead of carrying a
// permanent nav group for a mailbox they connect once.
describe("canViewIntegrationsNav", () => {
  it("keeps personal accounts out of the sidebar while leaving the page open", () => {
    for (const user of [
      { scope: "personal" },
      { scope: "personal", effective_role: "member" },
      { account_type: "personal" },
    ]) {
      expect(canViewIntegrationsNav(user)).toBe(false);
      // The page itself must stay reachable, or the profile-menu and Settings
      // entries would render a route they get bounced from.
      expect(canViewIntegrations(user)).toBe(true);
    }
  });

  it("still shows the group to organization and platform owners", () => {
    expect(
      canViewIntegrationsNav({ scope: "organization", effective_role: "owner" })
    ).toBe(true);
    expect(
      canViewIntegrationsNav({ scope: "platform", effective_role: "owner" })
    ).toBe(true);
    expect(
      canViewIntegrationsNav({
        account_type: "organization_admin",
        effective_role: "owner",
      })
    ).toBe(true);
  });

  it("inherits the non-owner and absent-user exclusions", () => {
    expect(
      canViewIntegrationsNav({ scope: "organization", effective_role: "member" })
    ).toBe(false);
    expect(canViewIntegrationsNav(null)).toBe(false);
    expect(canViewIntegrationsNav({})).toBe(false);
  });
});
