//! The notes list comes in pages and without note text; the text comes from
//! `GET /notes/{id}` when a note is opened. Search, sort and paging all run on
//! the server, and only ever over the caller's own notes.

#[cfg(test)]
mod tests {
    use crate::notes::handler::{get_note, list_notes};
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test as actix_test, web};
    use serde_json::Value;
    use sqlx::PgPool;

    struct Account {
        id: i32,
        token: String,
    }

    async fn account(pool: &PgPool) -> Account {
        let email = random_email();
        let id = insert_local_user(pool, &email, "password123").await;
        Account {
            id,
            token: jwt_for(id, &email),
        }
    }

    /// Seeds a note `minutes` minutes old, through the bypass GUC so setup
    /// isn't subject to RLS.
    async fn seed(pool: &PgPool, user_id: i32, title: &str, content: &str, minutes: i32) -> i32 {
        let mut tx = pool.begin().await.unwrap_or_else(|e| panic!("begin: {e}"));
        sqlx::query("SELECT set_config('app.bypass', 'on', true)")
            .execute(&mut *tx)
            .await
            .unwrap_or_else(|e| panic!("bypass: {e}"));
        let id: i32 = sqlx::query_scalar(
            "INSERT INTO notes (user_id, title, content, created_at, updated_at)
             VALUES ($1, $2, $3,
                     NOW() - make_interval(mins => $4 * 2),
                     NOW() - make_interval(mins => $4))
             RETURNING id",
        )
        .bind(user_id)
        .bind(title)
        .bind(content)
        .bind(minutes)
        .fetch_one(&mut *tx)
        .await
        .unwrap_or_else(|e| panic!("seed note: {e}"));
        tx.commit().await.unwrap_or_else(|e| panic!("commit: {e}"));
        id
    }

    async fn get(pool: &PgPool, who: &Account, uri: &str) -> (StatusCode, Value) {
        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(list_notes)
                .service(get_note),
        )
        .await;
        let res = actix_test::call_service(
            &app,
            actix_test::TestRequest::get()
                .uri(uri)
                .insert_header(("Authorization", format!("Bearer {}", who.token)))
                .to_request(),
        )
        .await;
        let status = res.status();
        let bytes = actix_test::read_body(res).await;
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    fn titles(body: &Value) -> Vec<String> {
        body["notes"]
            .as_array()
            .unwrap_or_else(|| panic!("no notes array in {body}"))
            .iter()
            .map(|n| n["title"].as_str().unwrap_or_default().to_owned())
            .collect()
    }

    #[actix_web::test]
    async fn pages_newest_edit_first_without_the_text() {
        let pool = test_pool().await;
        let me = account(&pool).await;
        for (i, name) in ["A", "B", "C", "D", "E"].iter().enumerate() {
            seed(&pool, me.id, name, "a long body", i as i32 + 1).await;
        }

        let (status, first) = get(&pool, &me, "/notes?limit=2").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(titles(&first), ["A", "B"]);
        assert_eq!(first["total"], 5);
        assert_eq!(first["has_more"], true);
        assert!(first["notes"][0].get("content").is_none(), "{first}");

        let (_, last) = get(&pool, &me, "/notes?limit=2&offset=4").await;
        assert_eq!(titles(&last), ["E"]);
        assert_eq!(last["has_more"], false);

        let (_, past) = get(&pool, &me, "/notes?limit=2&offset=50").await;
        assert_eq!(titles(&past), Vec::<String>::new());
        assert_eq!(past["total"], 5);
    }

    #[actix_web::test]
    async fn sorts_on_the_server() {
        let pool = test_pool().await;
        let me = account(&pool).await;
        seed(&pool, me.id, "banana", "", 3).await;
        seed(&pool, me.id, "Apple", "", 1).await;
        seed(&pool, me.id, "cherry", "", 2).await;

        let (_, by_name) = get(&pool, &me, "/notes?sort=name&dir=asc").await;
        assert_eq!(titles(&by_name), ["Apple", "banana", "cherry"]);
        let (_, oldest_first) = get(&pool, &me, "/notes?sort=created&dir=asc").await;
        assert_eq!(titles(&oldest_first), ["banana", "cherry", "Apple"]);
        // Anything unrecognised falls back to newest edit first.
        let (_, fallback) = get(&pool, &me, "/notes?sort=nonsense;DROP&dir=sideways").await;
        assert_eq!(titles(&fallback), ["Apple", "cherry", "banana"]);
    }

    #[actix_web::test]
    async fn searches_title_and_text_literally() {
        let pool = test_pool().await;
        let me = account(&pool).await;
        seed(&pool, me.id, "Groceries", "milk, EGGS", 1).await;
        seed(&pool, me.id, "Eggplant recipes", "", 2).await;
        seed(&pool, me.id, "Budget", "100% done", 3).await;
        seed(&pool, me.id, "Other", "nothing here", 4).await;

        let (_, eggs) = get(&pool, &me, "/notes?q=%20egg%20").await;
        assert_eq!(titles(&eggs), ["Groceries", "Eggplant recipes"]);
        assert_eq!(eggs["total"], 2);
        // `%` and `_` are matched as themselves, not as wildcards.
        let (_, percent) = get(&pool, &me, "/notes?q=0%25%20d").await;
        assert_eq!(titles(&percent), ["Budget"]);
        let (_, underscore) = get(&pool, &me, "/notes?q=_").await;
        assert_eq!(titles(&underscore), Vec::<String>::new());
    }

    #[actix_web::test]
    async fn only_ever_shows_the_callers_notes() {
        let pool = test_pool().await;
        let me = account(&pool).await;
        let other = account(&pool).await;
        let mine = seed(&pool, me.id, "Mine", "my text", 1).await;
        let theirs = seed(&pool, other.id, "Theirs", "their text", 1).await;

        let (_, list) = get(&pool, &me, "/notes?q=text").await;
        assert_eq!(titles(&list), ["Mine"]);
        assert_eq!(list["total"], 1);

        let (status, note) = get(&pool, &me, &format!("/notes/{mine}")).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(note["content"], "my text");
        assert_eq!(note["title"], "Mine");

        let (status, _) = get(&pool, &me, &format!("/notes/{theirs}")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[actix_web::test]
    async fn clamps_the_page_size() {
        let pool = test_pool().await;
        let me = account(&pool).await;
        seed(&pool, me.id, "One", "", 1).await;
        seed(&pool, me.id, "Two", "", 2).await;

        let (status, zero) = get(&pool, &me, "/notes?limit=0&offset=-5").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(titles(&zero), ["One"]);
        assert_eq!(zero["has_more"], true);
    }
}
