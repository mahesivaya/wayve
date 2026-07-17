// Integration and regression tests, scoped to the surfaces where a bug would be
// silent: encryption, authorization, JWT, signing, and the long-term API
// contracts. Tests that touch the database need a Postgres reachable via
// TEST_DATABASE_URL or DATABASE_URL (see test_support::test_pool). CI provides
// one; locally, run `psql "$DATABASE_URL" -f infra/postgres/init.sql` first.
mod admin_create_verification_test;
mod ai_config_test;
mod billing_audit_test;
mod chat_logging_test;
mod documents_rbac_test;
mod email_provider_isp_test;
mod embed_tokens_test;
mod gitlab_test;
mod jira_test;
mod jira_webhook_test;
mod mailbox_policy_test;
mod mcp_test;
mod meeting_link_test;
mod mode_switch_test;
mod org_keys_test;
mod platform_billing_feature_access_test;
mod platform_users_test;
mod quotas_test;
mod rbac_authorization_test;
mod rbac_permissions_golden_test;
mod rbac_resolution_test;
mod reactions_test;
mod redis_pubsub_perf_test;
mod repo_access_test;
mod rls_chat_test;
mod rls_emails_test;
mod rls_notes_test;
mod rls_reminders_test;
mod scheduler_create_meeting_validation_test;
mod scheduler_jwt_test;
mod scheduler_mail_delivery_test;
mod scheduler_zoom_test;
mod scim_tokens_test;
mod security_encryption_test;
mod slack_test;
mod slack_webhook_test;
mod task_suggest_test;
mod webhooks_test;
mod workspace_test;
