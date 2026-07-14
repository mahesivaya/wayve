//! Authorization and toggle semantics for emoji reactions.
//!
//! These drive the real `handle_react` handler that the WebSocket calls, with no
//! cache, so fan-out degrades to a no-op for users with no live session. What is
//! asserted is the resulting `message_reactions` rows, which is what says whether
//! the actor was allowed to react at all.

#[cfg(test)]
mod tests {
    use crate::chat::reactions::{ReactionFrame, grouped_for_messages, handle_react};
    use crate::test_support::{insert_local_user, random_email, test_pool};
    use sqlx::PgPool;

    fn frame(message_id: i32, is_channel: bool, emoji: &str) -> ReactionFrame {
        ReactionFrame {
            r#type: "react".to_string(),
            message_id,
            is_channel,
            emoji: emoji.to_string(),
        }
    }

    async fn react(pool: &PgPool, actor: i32, f: ReactionFrame) {
        handle_react(pool, &None, actor, f).await;
    }

    // Counts must be scoped to the reacting user, not the message id alone.
    // `messages` and `channel_messages` have independent id spaces, so a DM left
    // behind by an earlier test can share an id with this test's channel message.
    // Each test seeds fresh users, so the actor id keeps the count deterministic.
    async fn dm_reaction_count(pool: &PgPool, message_id: i32, user_id: i32) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM message_reactions WHERE message_id = $1 AND user_id = $2",
        )
        .bind(message_id)
        .bind(user_id)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("count: {e}"))
    }

    async fn channel_reaction_count(pool: &PgPool, message_id: i32, user_id: i32) -> i64 {
        sqlx::query_scalar(
            "SELECT count(*) FROM message_reactions \
             WHERE channel_message_id = $1 AND user_id = $2",
        )
        .bind(message_id)
        .bind(user_id)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("count: {e}"))
    }

    async fn seed_dm(pool: &PgPool, sender: i32, receiver: i32) -> i32 {
        sqlx::query_scalar(
            "INSERT INTO messages (sender_id, receiver_id) VALUES ($1, $2) RETURNING id",
        )
        .bind(sender)
        .bind(receiver)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("dm: {e}"))
    }

    /// Returns the id of one message in a fresh channel owned by `owner`.
    async fn seed_channel_message(pool: &PgPool, owner: i32, members: &[i32]) -> i32 {
        let ch: i32 = sqlx::query_scalar(
            "INSERT INTO channels (name, created_by) VALUES ($1, $2) RETURNING id",
        )
        .bind(format!("ch-{owner}-{}", uuid::Uuid::new_v4()))
        .bind(owner)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("channel: {e}"));

        for m in members {
            sqlx::query("INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)")
                .bind(ch)
                .bind(m)
                .execute(pool)
                .await
                .unwrap_or_else(|e| panic!("member: {e}"));
        }

        sqlx::query_scalar(
            "INSERT INTO channel_messages (channel_id, sender_id) VALUES ($1, $2) RETURNING id",
        )
        .bind(ch)
        .bind(owner)
        .fetch_one(pool)
        .await
        .unwrap_or_else(|e| panic!("channel message: {e}"))
    }

    #[tokio::test]
    async fn reacting_twice_with_the_same_emoji_toggles_it_off() {
        let pool = test_pool().await;
        let a = insert_local_user(&pool, &random_email(), "pw").await;
        let b = insert_local_user(&pool, &random_email(), "pw").await;
        let dm = seed_dm(&pool, a, b).await;

        react(&pool, b, frame(dm, false, "👍")).await;
        assert_eq!(dm_reaction_count(&pool, dm, b).await, 1, "first react adds");

        react(&pool, b, frame(dm, false, "👍")).await;
        assert_eq!(
            dm_reaction_count(&pool, dm, b).await,
            0,
            "same emoji removes"
        );

        // A different emoji is an independent reaction, not a replacement.
        react(&pool, b, frame(dm, false, "👍")).await;
        react(&pool, b, frame(dm, false, "🎉")).await;
        assert_eq!(dm_reaction_count(&pool, dm, b).await, 2);
    }

    #[tokio::test]
    async fn a_non_participant_cannot_react_to_a_dm() {
        let pool = test_pool().await;
        let a = insert_local_user(&pool, &random_email(), "pw").await;
        let b = insert_local_user(&pool, &random_email(), "pw").await;
        let stranger = insert_local_user(&pool, &random_email(), "pw").await;
        let dm = seed_dm(&pool, a, b).await;

        react(&pool, stranger, frame(dm, false, "👍")).await;
        assert_eq!(
            dm_reaction_count(&pool, dm, stranger).await,
            0,
            "a user who is neither sender nor receiver must not be able to react"
        );
    }

    #[tokio::test]
    async fn only_channel_members_can_react() {
        let pool = test_pool().await;
        let owner = insert_local_user(&pool, &random_email(), "pw").await;
        let member = insert_local_user(&pool, &random_email(), "pw").await;
        let outsider = insert_local_user(&pool, &random_email(), "pw").await;
        let cm = seed_channel_message(&pool, owner, &[owner, member]).await;

        react(&pool, outsider, frame(cm, true, "👍")).await;
        assert_eq!(
            channel_reaction_count(&pool, cm, outsider).await,
            0,
            "a non-member must not be able to react to a channel message"
        );

        react(&pool, member, frame(cm, true, "👍")).await;
        assert_eq!(channel_reaction_count(&pool, cm, member).await, 1);
    }

    #[tokio::test]
    async fn dm_and_channel_ids_do_not_collide() {
        // Because the two id spaces are independent, a reaction must land in the
        // column `is_channel` selects. Otherwise a channel reaction could attach
        // to an unrelated DM with the same id and be shown to the wrong people.
        let pool = test_pool().await;
        let owner = insert_local_user(&pool, &random_email(), "pw").await;
        let peer = insert_local_user(&pool, &random_email(), "pw").await;
        let cm = seed_channel_message(&pool, owner, &[owner]).await;

        let dm = seed_dm(&pool, owner, peer).await;

        react(&pool, owner, frame(cm, true, "🔥")).await;
        assert_eq!(channel_reaction_count(&pool, cm, owner).await, 1);
        assert_eq!(
            dm_reaction_count(&pool, cm, owner).await,
            0,
            "the channel reaction must not have been written against messages.id"
        );

        react(&pool, owner, frame(dm, false, "🔥")).await;
        assert_eq!(dm_reaction_count(&pool, dm, owner).await, 1);
    }

    #[tokio::test]
    async fn empty_and_oversized_emoji_are_rejected() {
        let pool = test_pool().await;
        let a = insert_local_user(&pool, &random_email(), "pw").await;
        let b = insert_local_user(&pool, &random_email(), "pw").await;
        let dm = seed_dm(&pool, a, b).await;

        react(&pool, b, frame(dm, false, "   ")).await;
        assert_eq!(
            dm_reaction_count(&pool, dm, b).await,
            0,
            "empty is rejected"
        );

        // The length cap is what stops `emoji` from smuggling a message body past
        // the E2E envelope check that `content` is subject to.
        let essay = "x".repeat(33);
        react(&pool, b, frame(dm, false, &essay)).await;
        assert_eq!(
            dm_reaction_count(&pool, dm, b).await,
            0,
            "an oversized 'emoji' is rejected"
        );
    }

    #[tokio::test]
    async fn grouping_batches_reactions_by_message() {
        let pool = test_pool().await;
        let a = insert_local_user(&pool, &random_email(), "pw").await;
        let b = insert_local_user(&pool, &random_email(), "pw").await;
        let dm1 = seed_dm(&pool, a, b).await;
        let dm2 = seed_dm(&pool, a, b).await;

        react(&pool, a, frame(dm1, false, "👍")).await;
        react(&pool, b, frame(dm1, false, "👍")).await;
        react(&pool, b, frame(dm2, false, "🎉")).await;

        let by_message = grouped_for_messages(&pool, &[dm1, dm2], false).await;

        let g1 = by_message
            .get(&dm1)
            .unwrap_or_else(|| panic!("dm1 missing from grouping"));
        assert_eq!(g1.len(), 1, "both 👍 collapse into one group");
        assert_eq!(g1[0].emoji, "👍");
        let mut reactors = g1[0].user_ids.clone();
        reactors.sort_unstable();
        let mut expected = vec![a, b];
        expected.sort_unstable();
        assert_eq!(reactors, expected, "the group lists everyone who reacted");

        let g2 = by_message
            .get(&dm2)
            .unwrap_or_else(|| panic!("dm2 missing from grouping"));
        assert_eq!(g2.len(), 1);
        assert_eq!(g2[0].emoji, "🎉");
    }
}
