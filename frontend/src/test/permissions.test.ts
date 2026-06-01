import { describe, it, expect } from "vitest";
import {
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  hasPermission,
  hasAnyPermission,
  permissionsForRole,
  normalizeRole,
  assignableRoles,
  canModifyMember,
} from "../auth/permissions";

describe("permission matrix", () => {
  it("owner has every permission", () => {
    for (const perm of PERMISSIONS) {
      expect(ROLE_PERMISSIONS.owner).toContain(perm);
    }
  });

  it("super_admin is owner minus billing AND org_keys:bootstrap", () => {
    // Matches backend rbac.rs: super_admin gets everything except the
    // two billing perms AND org_keys:bootstrap (which is owner-only,
    // because bootstrapping the mnemonic recovery root is the trust
    // anchor for the org's master key — not delegated to super_admin).
    for (const perm of PERMISSIONS) {
      const expected =
        perm !== "billing:manage" &&
        perm !== "billing:read" &&
        perm !== "org_keys:bootstrap";
      expect(ROLE_PERMISSIONS.super_admin.includes(perm)).toBe(expected);
    }
  });

  it("org_keys:bootstrap is owner-only", () => {
    expect(ROLE_PERMISSIONS.owner).toContain("org_keys:bootstrap");
    for (const role of [
      "super_admin", "admin", "security", "billing",
      "developer", "support", "member", "guest",
    ] as const) {
      expect(ROLE_PERMISSIONS[role]).not.toContain("org_keys:bootstrap");
    }
  });

  it("org_keys:use_master is owner / super_admin / admin", () => {
    for (const role of ["owner", "super_admin", "admin"] as const) {
      expect(ROLE_PERMISSIONS[role]).toContain("org_keys:use_master");
    }
    for (const role of [
      "security", "billing", "developer", "support", "member", "guest",
    ] as const) {
      expect(ROLE_PERMISSIONS[role]).not.toContain("org_keys:use_master");
    }
  });

  it("member and guest share the baseline bundle", () => {
    for (const role of ["member", "guest"] as const) {
      expect([...ROLE_PERMISSIONS[role]].sort()).toEqual(
        ["apps:use", "profile:manage_self"].sort()
      );
    }
  });

  it("billing role owns billing but not security or members:manage", () => {
    expect(ROLE_PERMISSIONS.billing).toContain("billing:manage");
    expect(ROLE_PERMISSIONS.billing).toContain("usage:read");
    expect(ROLE_PERMISSIONS.billing).not.toContain("security:manage");
    expect(ROLE_PERMISSIONS.billing).not.toContain("members:manage");
  });

  it("admin manages members but not roles fully, org:delete, or billing", () => {
    expect(ROLE_PERMISSIONS.admin).toContain("members:manage");
    expect(ROLE_PERMISSIONS.admin).toContain("roles:assign_limited");
    expect(ROLE_PERMISSIONS.admin).not.toContain("roles:manage");
    expect(ROLE_PERMISSIONS.admin).not.toContain("org:delete");
    expect(ROLE_PERMISSIONS.admin).not.toContain("billing:manage");
  });

  it("every role references only known permissions", () => {
    for (const role of ROLES) {
      for (const perm of ROLE_PERMISSIONS[role]) {
        expect(PERMISSIONS).toContain(perm);
      }
    }
  });
});

describe("hasPermission", () => {
  it("checks the holder's permission list", () => {
    const user = { permissions: ["apps:use", "members:read"] };
    expect(hasPermission(user, "members:read")).toBe(true);
    expect(hasPermission(user, "members:manage")).toBe(false);
  });

  it("is false for null / undefined / permission-less holders", () => {
    expect(hasPermission(null, "apps:use")).toBe(false);
    expect(hasPermission(undefined, "apps:use")).toBe(false);
    expect(hasPermission({}, "apps:use")).toBe(false);
  });

  it("hasAnyPermission ORs the checks", () => {
    const user = { permissions: ["usage:read"] };
    expect(hasAnyPermission(user, ["members:manage", "usage:read"])).toBe(true);
    expect(hasAnyPermission(user, ["members:manage", "org:delete"])).toBe(false);
  });
});

describe("role helpers", () => {
  it("normalizeRole falls back to member for unknown values", () => {
    expect(normalizeRole("super_admin")).toBe("super_admin");
    expect(normalizeRole("guest")).toBe("guest");
    expect(normalizeRole("bogus")).toBe("member");
    expect(normalizeRole(null)).toBe("member");
  });

  it("permissionsForRole returns the role's bundle", () => {
    expect(permissionsForRole("guest")).toEqual([
      "apps:use",
      "profile:manage_self",
    ]);
    expect(permissionsForRole("bogus")).toEqual([
      "apps:use",
      "profile:manage_self",
    ]);
  });
});

describe("assignableRoles / canModifyMember", () => {
  it("roles:manage may assign and modify anything", () => {
    expect(assignableRoles(["roles:manage"])).toEqual([...ROLES]);
    expect(canModifyMember(["roles:manage"], "owner")).toBe(true);
  });

  it("roles:assign_limited only offers roles below admin", () => {
    const limited = assignableRoles(["roles:assign_limited"]);
    expect(limited).not.toContain("owner");
    expect(limited).not.toContain("super_admin");
    expect(limited).not.toContain("admin");
    expect(limited).toContain("member");
    expect(limited).toContain("guest");
  });

  it("roles:assign_limited cannot modify admin-or-above members", () => {
    expect(canModifyMember(["roles:assign_limited"], "member")).toBe(true);
    expect(canModifyMember(["roles:assign_limited"], "developer")).toBe(true);
    expect(canModifyMember(["roles:assign_limited"], "admin")).toBe(false);
    expect(canModifyMember(["roles:assign_limited"], "super_admin")).toBe(false);
    expect(canModifyMember(["roles:assign_limited"], "owner")).toBe(false);
  });

  it("no role permission means nothing is assignable", () => {
    expect(assignableRoles([])).toEqual([]);
    expect(assignableRoles(null)).toEqual([]);
    expect(canModifyMember([], "member")).toBe(false);
  });
});
