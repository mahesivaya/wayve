#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use wayve_security::rbac::{Permission, Role, permissions_for, role_has};

    // Golden snapshot of the role -> permission set. Any change to the matrix
    // in wayve-security/src/rbac.rs must update this table; otherwise this
    // test fails loudly with a clear diff — exactly the kind of silent
    // privilege drift the migration to a HashMap-backed catalog would
    // otherwise enable.
    fn expected_for(role: Role) -> BTreeSet<&'static str> {
        let strs: &[&str] = match role {
            Role::Owner => &[
                "apps:use",
                "apps:manage",
                "profile:manage_self",
                "members:read",
                "members:manage",
                "roles:manage",
                "roles:assign_limited",
                "org:settings",
                "org:delete",
                "billing:manage",
                "billing:read",
                "usage:read",
                "api_keys:manage",
                "webhooks:manage",
                "integrations:manage",
                "logs:read",
                "logs:read_limited",
                "audit:read",
                "security:manage",
                "tickets:manage",
                "sso:manage",
                "inbox:manage",
                "mcp:manage",
                "ai:manage",
                "org_keys:bootstrap",
                "org_keys:use_master",
                "documents:manage",
                "task_statuses:manage",
            ],
            Role::SuperAdmin => &[
                "apps:use",
                "apps:manage",
                "profile:manage_self",
                "members:read",
                "members:manage",
                "roles:manage",
                "roles:assign_limited",
                "org:settings",
                "org:delete",
                "usage:read",
                "api_keys:manage",
                "webhooks:manage",
                "integrations:manage",
                "logs:read",
                "logs:read_limited",
                "audit:read",
                "security:manage",
                "tickets:manage",
                "sso:manage",
                "inbox:manage",
                "mcp:manage",
                // super_admin gets the master-key USE permission but NOT
                // bootstrap — only the original owner can mint the
                // mnemonic recovery root or promote a new key-holder.
                "org_keys:use_master",
                // Documents management is owner + super_admin only (not admin).
                "documents:manage",
                "task_statuses:manage",
            ],
            Role::Admin => &[
                "apps:use",
                "apps:manage",
                "profile:manage_self",
                "members:read",
                "members:manage",
                "roles:assign_limited",
                "org:settings",
                "usage:read",
                "sso:manage",
                "inbox:manage",
                "mcp:manage",
                // Admin holds the org master key wrap so they can reset
                // member passwords and recover departing-member data
                // without involving the owner.
                "org_keys:use_master",
                // Admin configures the task workflow alongside org:settings.
                "task_statuses:manage",
            ],
            Role::Security => &[
                "apps:use",
                "profile:manage_self",
                "members:read",
                "members:manage",
                "roles:assign_limited",
                "logs:read",
                "logs:read_limited",
                "audit:read",
                "security:manage",
                "sso:manage",
            ],
            Role::Billing => &[
                "apps:use",
                "profile:manage_self",
                "members:read",
                "billing:manage",
                "billing:read",
                "usage:read",
            ],
            Role::Developer => &[
                "apps:use",
                "profile:manage_self",
                "api_keys:manage",
                "webhooks:manage",
                "integrations:manage",
                "logs:read",
                "logs:read_limited",
            ],
            Role::Support => &[
                "apps:use",
                "profile:manage_self",
                "members:read",
                "usage:read",
                "logs:read_limited",
                "tickets:manage",
            ],
            Role::Member | Role::Guest => &["apps:use", "profile:manage_self"],
        };
        strs.iter().copied().collect()
    }

    fn actual_for(role: Role) -> BTreeSet<&'static str> {
        permissions_for(role).iter().map(|p| p.as_str()).collect()
    }

    #[test]
    fn role_permission_matrix_matches_golden() {
        for role in Role::ALL {
            let expected = expected_for(role);
            let actual = actual_for(role);

            let missing: Vec<_> = expected.difference(&actual).copied().collect();
            let extra: Vec<_> = actual.difference(&expected).copied().collect();

            assert!(
                missing.is_empty() && extra.is_empty(),
                "{role:?}: missing={missing:?} extra={extra:?}",
            );
        }
    }

    #[test]
    fn role_has_agrees_with_permissions_for_for_every_pair() {
        for role in Role::ALL {
            let perms = permissions_for(role);
            for perm in Permission::ALL {
                let expected = perms.contains(&perm);
                assert_eq!(
                    role_has(role, perm),
                    expected,
                    "role_has({role:?}, {perm:?}) disagrees with permissions_for",
                );
            }
        }
    }
}
