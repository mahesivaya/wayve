#[cfg(test)]
mod tests {
    use crate::drive::folders::delete_folder;
    use crate::drive::handler::upload_file;
    use crate::test_support::{delete_user, insert_local_user, jwt_for, random_email, test_pool};
    use actix_web::{App, http::StatusCode, test, web};
    use sqlx::Row;

    #[actix_web::test]
    async fn upload_requires_auth() {
        let pool = test_pool().await;
        let app = test::init_service(
            App::new()
                .app_data(web::Data::new(pool))
                .service(upload_file),
        )
        .await;
        let req = test::TestRequest::post().uri("/files/upload").to_request();
        let resp = test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn deleting_folder_cascades_nested_children_and_files() {
        let pool = test_pool().await;
        let email = random_email();
        let user_id = insert_local_user(&pool, &email, "password").await;
        let jwt = jwt_for(user_id, &email);

        let root_id: i64 =
            sqlx::query("INSERT INTO folders (user_id, name) VALUES ($1, $2) RETURNING id")
                .bind(user_id)
                .bind("root folder")
                .fetch_one(&pool)
                .await
                .unwrap()
                .get("id");

        let child_id: i64 = sqlx::query(
            "INSERT INTO folders (user_id, parent_folder_id, name) VALUES ($1, $2, $3) RETURNING id",
        )
        .bind(user_id)
        .bind(root_id)
        .bind("child folder")
        .fetch_one(&pool)
        .await
        .unwrap()
        .get("id");

        let grandchild_id: i64 = sqlx::query(
            "INSERT INTO folders (user_id, parent_folder_id, name) VALUES ($1, $2, $3) RETURNING id",
        )
        .bind(user_id)
        .bind(child_id)
        .bind("grandchild folder")
        .fetch_one(&pool)
        .await
        .unwrap()
        .get("id");

        sqlx::query(
            "INSERT INTO files (user_id, folder_id, name, file_type, file_path, size)
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(user_id)
        .bind(grandchild_id)
        .bind("nested.txt")
        .bind("txt")
        .bind("/tmp/nested.txt")
        .bind(12_i64)
        .execute(&pool)
        .await
        .unwrap();

        let app = test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(delete_folder),
        )
        .await;

        let req = test::TestRequest::delete()
            .uri(&format!("/folders/{root_id}"))
            .insert_header(("Authorization", format!("Bearer {jwt}")))
            .to_request();
        let resp = test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK);

        let folder_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM folders WHERE id = ANY($1)")
                .bind(&[root_id, child_id, grandchild_id])
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(folder_count, 0, "folder delete must remove all descendants");

        let file_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM files WHERE folder_id = $1")
            .bind(grandchild_id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(file_count, 0, "folder delete must remove nested files");

        delete_user(&pool, user_id).await;
    }
}
