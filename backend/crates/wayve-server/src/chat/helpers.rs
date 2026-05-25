use sqlx::PgPool;

pub async fn is_channel_admin(
    pool: &PgPool,
    channel_id: i32,
    user_id: i32,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS(
            SELECT 1
            FROM channel_members
            WHERE channel_id = $1 AND user_id = $2 AND role = 'admin'
        )
        "#,
    )
    .bind(channel_id)
    .bind(user_id)
    .fetch_one(pool)
    .await
}

pub fn normalize_invite_emails(emails: &[String]) -> Vec<String> {
    let mut emails = emails
        .iter()
        .map(|email| email.trim().to_lowercase())
        .filter(|email| !email.is_empty())
        .collect::<Vec<_>>();
    emails.sort();
    emails.dedup();
    emails
}

pub fn normalize_channel_role(role: Option<&str>) -> &'static str {
    match role {
        Some("admin") => "admin",
        _ => "user",
    }
}
