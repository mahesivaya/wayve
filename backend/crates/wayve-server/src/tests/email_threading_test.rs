// Conversation threading (email/threading.rs) against a real Postgres: replies
// join their parent's conversation (also when they arrive first), a provider
// conversation id groups on its own, the subject fallback links only replies
// from the same correspondent, mailboxes never share a conversation, re-syncs
// keep theirs, and the backfill threads existing Gmail mail via a mocked API.
#[cfg(test)]
mod tests {
    use crate::email::threading::{ThreadHeaders, ThreadInput, assign_best_effort, backfill_batch};
    use crate::test_support::{insert_local_user, random_email, test_pool};
    use chrono::{Duration, NaiveDateTime, Utc};
    use sqlx::PgPool;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// The keyed hashes are derived from `AES_KEY`.
    fn ensure_aes_key() {
        unsafe {
            if std::env::var("AES_KEY").is_err() {
                std::env::set_var(
                    "AES_KEY",
                    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                );
            }
        }
    }

    async fn mailbox(pool: &PgPool) -> i32 {
        let user = insert_local_user(pool, &random_email(), "password123").await;
        sqlx::query_scalar(
            "INSERT INTO email_accounts (email, user_id, provider) VALUES ($1, $2, 'google') RETURNING id",
        )
        .bind(random_email())
        .bind(user)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("mailbox: {e}"))
    }

    /// A synced email row. `receiver` matters to the subject fallback, which
    /// matches the correspondent on either side.
    async fn email(
        pool: &PgPool,
        account: i32,
        gmail_id: &str,
        receiver: &str,
        at: NaiveDateTime,
    ) -> i32 {
        let receiver_hash = wayve_security::encryption::compute_address_hash(receiver)
            .ok()
            .flatten();
        sqlx::query_scalar(
            "INSERT INTO emails (gmail_id, account_id, created_at, receiver_hash) VALUES ($1, $2, $3, $4) RETURNING id",
        )
        .bind(gmail_id)
        .bind(account)
        .bind(at)
        .bind(receiver_hash)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("email: {e}"))
    }

    async fn thread_of(pool: &PgPool, email_id: i32) -> Option<i32> {
        sqlx::query_scalar("SELECT thread_id FROM emails WHERE id = $1")
            .bind(email_id)
            .fetch_one(pool)
            .await
            .unwrap_or_else(|e| panic!("thread_of: {e}"))
    }

    fn headers(id: &str, in_reply_to: Option<&str>, refs: Option<&str>) -> ThreadHeaders {
        ThreadHeaders::from_raw(Some(id), in_reply_to, refs, None)
    }

    fn now() -> NaiveDateTime {
        Utc::now().naive_utc()
    }

    #[actix_web::test]
    async fn a_reply_joins_its_parent_and_a_reply_to_the_reply_too() {
        ensure_aes_key();
        let pool = test_pool().await;
        let acct = mailbox(&pool).await;

        let first = email(&pool, acct, "g1", "", now()).await;
        assign_best_effort(
            &pool,
            acct,
            ThreadInput {
                email_id: first,
                headers: &headers("<q1@cust.com>", None, None),
                subject: "Help with login",
                sender: "cust@x.com",
                receiver: "",
                created_at: Some(now()),
            },
        )
        .await;
        let reply = email(&pool, acct, "g2", "cust@x.com", now()).await;
        assign_best_effort(
            &pool,
            acct,
            ThreadInput {
                email_id: reply,
                headers: &headers("<a1@us.com>", Some("<q1@cust.com>"), Some("<q1@cust.com>")),
                subject: "Re: Help with login",
                sender: "agent@us.com",
                receiver: "",
                created_at: Some(now()),
            },
        )
        .await;
        let again = email(&pool, acct, "g3", "", now()).await;
        assign_best_effort(
            &pool,
            acct,
            ThreadInput {
                email_id: again,
                headers: &headers(
                    "<q2@cust.com>",
                    Some("<a1@us.com>"),
                    Some("<q1@cust.com> <a1@us.com>"),
                ),
                subject: "Re: Help with login",
                sender: "cust@x.com",
                receiver: "",
                created_at: Some(now()),
            },
        )
        .await;

        let t = thread_of(&pool, first).await;
        assert!(t.is_some());
        assert_eq!(thread_of(&pool, reply).await, t);
        assert_eq!(thread_of(&pool, again).await, t);
    }

    #[actix_web::test]
    async fn a_reply_that_arrives_first_merges_when_its_parent_lands() {
        ensure_aes_key();
        let pool = test_pool().await;
        let acct = mailbox(&pool).await;

        let reply = email(&pool, acct, "r", "", now()).await;
        assign_best_effort(
            &pool,
            acct,
            ThreadInput {
                email_id: reply,
                headers: &headers("<child@x>", Some("<parent@x>"), None),
                subject: "Re: Order",
                sender: "a@x.com",
                receiver: "",
                created_at: Some(now()),
            },
        )
        .await;
        let unrelated = email(&pool, acct, "u", "", now()).await;
        assign_best_effort(
            &pool,
            acct,
            ThreadInput {
                email_id: unrelated,
                headers: &headers("<other@x>", None, None),
                subject: "Other",
                sender: "b@x.com",
                receiver: "",
                created_at: Some(now()),
            },
        )
        .await;
        let parent = email(&pool, acct, "p", "", now()).await;
        assign_best_effort(
            &pool,
            acct,
            ThreadInput {
                email_id: parent,
                headers: &headers("<parent@x>", None, None),
                subject: "Order",
                sender: "c@x.com",
                receiver: "",
                created_at: Some(now()),
            },
        )
        .await;

        assert_eq!(
            thread_of(&pool, parent).await,
            thread_of(&pool, reply).await
        );
        assert_ne!(
            thread_of(&pool, unrelated).await,
            thread_of(&pool, reply).await
        );
    }

    #[actix_web::test]
    async fn this_email_links_two_conversations_into_one() {
        ensure_aes_key();
        let pool = test_pool().await;
        let acct = mailbox(&pool).await;

        // Two replies to a parent we don't have yet start apart...
        let a = email(&pool, acct, "a", "", now()).await;
        assign_best_effort(
            &pool,
            acct,
            ThreadInput {
                email_id: a,
                headers: &headers("<a@x>", Some("<root@x>"), None),
                subject: "Re: X",
                sender: "a@x.com",
                receiver: "",
                created_at: Some(now()),
            },
        )
        .await;
        let b = email(&pool, acct, "b", "", now()).await;
        assign_best_effort(
            &pool,
            acct,
            ThreadInput {
                email_id: b,
                headers: &headers("<b@x>", None, Some("<root@x>")),
                subject: "X",
                sender: "b@x.com",
                receiver: "",
                created_at: Some(now()),
            },
        )
        .await;
        // ...until the root arrives and joins both.
        let root = email(&pool, acct, "root", "", now()).await;
        assign_best_effort(
            &pool,
            acct,
            ThreadInput {
                email_id: root,
                headers: &headers("<root@x>", None, None),
                subject: "X",
                sender: "c@x.com",
                receiver: "",
                created_at: Some(now()),
            },
        )
        .await;

        let t = thread_of(&pool, root).await;
        assert_eq!(thread_of(&pool, a).await, t);
        assert_eq!(thread_of(&pool, b).await, t);
        let threads: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM email_threads WHERE account_id = $1")
                .bind(acct)
                .fetch_one(&pool)
                .await
                .unwrap_or_else(|e| panic!("count: {e}"));
        assert_eq!(threads, 1, "merged conversations are deleted, not orphaned");
    }

    #[actix_web::test]
    async fn the_provider_conversation_id_groups_without_headers() {
        ensure_aes_key();
        let pool = test_pool().await;
        let acct = mailbox(&pool).await;
        let gmail = |tid: &str| ThreadHeaders::from_raw(None, None, None, Some(tid));

        let x = email(&pool, acct, "x", "", now()).await;
        assign_best_effort(
            &pool,
            acct,
            ThreadInput {
                email_id: x,
                headers: &gmail("18f00aa"),
                subject: "Hello",
                sender: "a@x.com",
                receiver: "",
                created_at: Some(now()),
            },
        )
        .await;
        let y = email(&pool, acct, "y", "", now()).await;
        assign_best_effort(
            &pool,
            acct,
            ThreadInput {
                email_id: y,
                headers: &gmail("18f00aa"),
                subject: "Completely different",
                sender: "b@x.com",
                receiver: "",
                created_at: Some(now()),
            },
        )
        .await;
        let z = email(&pool, acct, "z", "", now()).await;
        assign_best_effort(
            &pool,
            acct,
            ThreadInput {
                email_id: z,
                headers: &gmail("18f00bb"),
                subject: "Hello",
                sender: "a@x.com",
                receiver: "",
                created_at: Some(now()),
            },
        )
        .await;

        assert_eq!(thread_of(&pool, x).await, thread_of(&pool, y).await);
        assert_ne!(thread_of(&pool, x).await, thread_of(&pool, z).await);
    }

    #[actix_web::test]
    async fn the_subject_fallback_links_only_replies_from_the_same_correspondent() {
        ensure_aes_key();
        let pool = test_pool().await;
        let acct = mailbox(&pool).await;
        // The mailbox owner is on every email, so it must not count as the
        // shared correspondent.
        sqlx::query("UPDATE email_accounts SET email = 'us@us.com' WHERE id = $1")
            .bind(acct)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("owner address: {e}"));
        let none = ThreadHeaders::default();
        let input =
            |email_id: i32,
             subject: &'static str,
             sender: &'static str,
             receiver: &'static str,
             at: NaiveDateTime| { (email_id, subject, sender, receiver, at) };
        let assign =
            |(email_id, subject, sender, receiver, at): (i32, &str, &str, &str, NaiveDateTime)| {
                let pool = pool.clone();
                let headers = none.clone();
                let (subject, sender, receiver) = (
                    subject.to_string(),
                    sender.to_string(),
                    receiver.to_string(),
                );
                async move {
                    assign_best_effort(
                        &pool,
                        acct,
                        ThreadInput {
                            email_id,
                            headers: &headers,
                            subject: &subject,
                            sender: &sender,
                            receiver: &receiver,
                            created_at: Some(at),
                        },
                    )
                    .await;
                }
            };

        // Our outgoing question, addressed to the customer's bare address.
        let ours = email(&pool, acct, "o", "cust@x.com", now()).await;
        assign(input(ours, "Invoice 42", "us@us.com", "cust@x.com", now())).await;
        // Their reply lost its headers (a broken client), but says "Re:". The
        // display name and case differ from what we wrote; still the same person.
        let theirs = email(&pool, acct, "t", "", now()).await;
        assign(input(
            theirs,
            "RE:  invoice 42",
            "Customer Name <Cust@X.com>",
            "us@us.com",
            now(),
        ))
        .await;
        // Someone else replying with the same subject is a different conversation,
        // even though we (the owner) are on both.
        let stranger = email(&pool, acct, "s", "", now()).await;
        assign(input(
            stranger,
            "Re: Invoice 42",
            "other@y.com",
            "us@us.com",
            now(),
        ))
        .await;
        // A new (non-reply) email with the same subject from the same customer
        // starts a new conversation.
        let fresh = email(&pool, acct, "f", "", now()).await;
        assign(input(fresh, "Invoice 42", "cust@x.com", "us@us.com", now())).await;
        // A reply more than 30 days later doesn't reach back.
        let late_at = now() + Duration::days(45);
        let late = email(&pool, acct, "l", "", late_at).await;
        assign(input(
            late,
            "Re: Invoice 42",
            "cust@x.com",
            "us@us.com",
            late_at,
        ))
        .await;
        // A reply answers something earlier: one dated before our question
        // never joins it, however it's ordered in the sync.
        let before_at = now() - Duration::days(1);
        let before = email(&pool, acct, "b", "", before_at).await;
        assign(input(
            before,
            "Re: Invoice 42",
            "cust@x.com",
            "us@us.com",
            before_at,
        ))
        .await;

        assert_eq!(thread_of(&pool, theirs).await, thread_of(&pool, ours).await);
        for other in [stranger, fresh, late, before] {
            assert_ne!(thread_of(&pool, other).await, thread_of(&pool, ours).await);
        }
    }

    #[actix_web::test]
    async fn the_subject_fallback_never_overrides_a_provider_conversation() {
        ensure_aes_key();
        let pool = test_pool().await;
        let acct = mailbox(&pool).await;
        let none = ThreadHeaders::default();

        let ours = email(&pool, acct, "o", "cust@x.com", now()).await;
        assign_best_effort(
            &pool,
            acct,
            ThreadInput {
                email_id: ours,
                headers: &none,
                subject: "Status",
                sender: "us@us.com",
                receiver: "cust@x.com",
                created_at: Some(now()),
            },
        )
        .await;
        // The first message of its Gmail conversation to be threaded (the
        // backfill runs newest first): it carries Gmail's own conversation id,
        // so a same-subject guess must not pull it into ours.
        let gmail = ThreadHeaders::from_raw(None, None, None, Some("gmail-thread-1"));
        let theirs = email(&pool, acct, "t", "", now()).await;
        assign_best_effort(
            &pool,
            acct,
            ThreadInput {
                email_id: theirs,
                headers: &gmail,
                subject: "Re: Status",
                sender: "cust@x.com",
                receiver: "us@us.com",
                created_at: Some(now()),
            },
        )
        .await;

        assert_ne!(thread_of(&pool, theirs).await, thread_of(&pool, ours).await);
    }

    #[actix_web::test]
    async fn mailboxes_never_share_a_conversation() {
        ensure_aes_key();
        let pool = test_pool().await;
        let (one, two) = (mailbox(&pool).await, mailbox(&pool).await);

        let a = email(&pool, one, "m", "", now()).await;
        assign_best_effort(
            &pool,
            one,
            ThreadInput {
                email_id: a,
                headers: &headers("<same@x>", None, None),
                subject: "Hi",
                sender: "a@x.com",
                receiver: "",
                created_at: Some(now()),
            },
        )
        .await;
        let b = email(&pool, two, "m", "", now()).await;
        assign_best_effort(
            &pool,
            two,
            ThreadInput {
                email_id: b,
                headers: &headers("<r@x>", Some("<same@x>"), None),
                subject: "Re: Hi",
                sender: "a@x.com",
                receiver: "",
                created_at: Some(now()),
            },
        )
        .await;

        assert_ne!(thread_of(&pool, a).await, thread_of(&pool, b).await);
    }

    #[actix_web::test]
    async fn a_resync_keeps_the_conversation_and_stores_no_plain_ids() {
        ensure_aes_key();
        let pool = test_pool().await;
        let acct = mailbox(&pool).await;
        let e = email(&pool, acct, "k", "", now()).await;
        let h = headers("<keep@x>", None, None);
        assign_best_effort(
            &pool,
            acct,
            ThreadInput {
                email_id: e,
                headers: &h,
                subject: "Hi",
                sender: "a@x.com",
                receiver: "",
                created_at: Some(now()),
            },
        )
        .await;
        let before = thread_of(&pool, e).await;
        assign_best_effort(
            &pool,
            acct,
            ThreadInput {
                email_id: e,
                headers: &h,
                subject: "Hi",
                sender: "a@x.com",
                receiver: "",
                created_at: Some(now()),
            },
        )
        .await;
        assert_eq!(thread_of(&pool, e).await, before);

        let (hash, enc): (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT message_id_hash, message_id_encrypted FROM email_thread_meta WHERE email_id = $1",
        )
        .bind(e)
        .fetch_one(&pool)
        .await
        .unwrap_or_else(|err| panic!("meta: {err}"));
        assert!(hash.is_some_and(|h| h.len() == 64 && !h.contains("keep")));
        assert!(
            enc.is_some_and(|c| !c.contains("keep@x")),
            "raw id is encrypted"
        );
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn backfill_threads_existing_gmail_mail_and_skips_deleted() {
        ensure_aes_key();
        let mock = MockServer::start().await;
        let message = |tid: &str| {
            serde_json::json!({
                "id": "x", "threadId": tid, "labelIds": ["INBOX"], "internalDate": "1700000000000",
                "payload": { "headers": [
                    { "name": "From", "value": "cust@x.com" },
                    { "name": "Subject", "value": "Order" },
                    { "name": "Message-Id", "value": "<id@x>" }
                ]}
            })
        };
        for (id, tid) in [("old1", "T1"), ("old2", "T1"), ("old3", "T2")] {
            Mock::given(method("GET"))
                .and(path(format!("/gmail/v1/users/me/messages/{id}")))
                .respond_with(ResponseTemplate::new(200).set_body_json(message(tid)))
                .mount(&mock)
                .await;
        }
        Mock::given(method("GET"))
            .and(path("/gmail/v1/users/me/messages/gone"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&mock)
            .await;
        // SAFETY: serialized via #[serial].
        unsafe {
            std::env::set_var("GMAIL_API_BASE", mock.uri());
        }

        let pool = test_pool().await;
        let acct = mailbox(&pool).await;
        let mut ids = Vec::new();
        for g in ["old1", "old2", "old3", "gone"] {
            ids.push(email(&pool, acct, g, "", now()).await);
        }

        let n = backfill_batch(
            &pool,
            acct,
            &crate::email::provider::MailProvider::Google,
            "tok",
        )
        .await
        .unwrap_or_else(|e| panic!("backfill: {e}"));
        assert_eq!(n, 4);
        assert_eq!(
            thread_of(&pool, ids[0]).await,
            thread_of(&pool, ids[1]).await
        );
        assert_ne!(
            thread_of(&pool, ids[0]).await,
            thread_of(&pool, ids[2]).await
        );
        assert!(
            thread_of(&pool, ids[3]).await.is_some(),
            "a deleted message gets its own"
        );

        let again = backfill_batch(
            &pool,
            acct,
            &crate::email::provider::MailProvider::Google,
            "tok",
        )
        .await
        .unwrap_or_else(|e| panic!("backfill: {e}"));
        assert_eq!(again, 0, "nothing is fetched twice");
        unsafe {
            std::env::remove_var("GMAIL_API_BASE");
        }
    }
}
