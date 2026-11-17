// Files attached to a user story: upload, list, download and delete are scoped
// to the story's owner, and a story in someone else's backlog answers 404 so
// its existence never leaks.
#[cfg(test)]
mod tests {
    use crate::test_support::{insert_local_user, jwt_for, random_email, test_pool};
    use crate::user_stories::attachments::{
        delete_attachment, download_attachment, list_attachments, upload_attachments,
    };
    use crate::user_stories::handler::create_user_story;
    use actix_web::{App, http::StatusCode, test as actix_test, web};

    const BOUNDARY: &str = "----wayve-test-boundary";
    const FILE_BYTES: &[u8] = b"acceptance criteria:\n- it works\n";

    /// A multipart body carrying one `files` part named `name`.
    fn multipart(name: &str, bytes: &[u8]) -> Vec<u8> {
        let mut body = format!(
            "--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"files\"; \
             filename=\"{name}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        )
        .into_bytes();
        body.extend_from_slice(bytes);
        body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());
        body
    }

    #[actix_web::test]
    #[serial_test::serial]
    async fn story_attachments_round_trip_and_stay_with_their_owner() {
        // Attachments are encrypted at rest, so the handler needs `AES_KEY`.
        // SAFETY: env mutation is serialized by #[serial]; CI runs --test-threads=1.
        unsafe {
            if std::env::var("AES_KEY").is_err() {
                std::env::set_var(
                    "AES_KEY",
                    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                );
            }
        }
        let pool = test_pool().await;
        let owner_email = random_email();
        let owner = insert_local_user(&pool, &owner_email, "password123").await;
        let other_email = random_email();
        let other = insert_local_user(&pool, &other_email, "password123").await;
        let owner_auth = format!("Bearer {}", jwt_for(owner, &owner_email));
        let other_auth = format!("Bearer {}", jwt_for(other, &other_email));

        let app = actix_test::init_service(
            App::new()
                .app_data(web::Data::new(pool.clone()))
                .service(create_user_story)
                .service(upload_attachments)
                .service(list_attachments)
                .service(download_attachment)
                .service(delete_attachment),
        )
        .await;

        // The owner creates a story and attaches a file to it.
        let req = actix_test::TestRequest::post()
            .uri("/user-stories")
            .insert_header(("Authorization", owner_auth.clone()))
            .set_json(serde_json::json!({ "name": "Story with a spec" }))
            .to_request();
        let story: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;
        let story_id = story["id"]
            .as_i64()
            .unwrap_or_else(|| panic!("story id missing in {story}"));

        let upload = |auth: String| {
            actix_test::TestRequest::post()
                .uri(&format!("/user-stories/{story_id}/attachments"))
                .insert_header(("Authorization", auth))
                .insert_header((
                    "Content-Type",
                    format!("multipart/form-data; boundary={BOUNDARY}"),
                ))
                .set_payload(multipart("../spec.md", FILE_BYTES))
                .to_request()
        };

        // Someone else can't attach to it.
        let resp = actix_test::call_service(&app, upload(other_auth.clone())).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND, "other user's upload");

        let resp = actix_test::call_service(&app, upload(owner_auth.clone())).await;
        assert_eq!(resp.status(), StatusCode::OK, "owner's upload");
        let saved: serde_json::Value = actix_test::read_body_json(resp).await;
        let attachment = &saved[0];
        // Path separators are stripped from the stored name.
        assert_eq!(attachment["name"], "..spec.md");
        assert_eq!(attachment["task_id"].as_i64(), Some(story_id));
        assert_eq!(attachment["size"].as_i64(), Some(FILE_BYTES.len() as i64));
        let attachment_id = attachment["id"]
            .as_i64()
            .unwrap_or_else(|| panic!("attachment id missing in {saved}"));

        // The owner sees it listed and gets the same bytes back.
        let req = actix_test::TestRequest::get()
            .uri(&format!("/user-stories/{story_id}/attachments"))
            .insert_header(("Authorization", owner_auth.clone()))
            .to_request();
        let listed: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;
        assert_eq!(listed.as_array().map(Vec::len), Some(1));

        let req = actix_test::TestRequest::get()
            .uri(&format!("/story-attachments/{attachment_id}/download"))
            .insert_header(("Authorization", owner_auth.clone()))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK, "owner's download");
        assert_eq!(actix_test::read_body(resp).await.as_ref(), FILE_BYTES);

        // The other user can't list, download or delete it.
        for (method, uri) in [
            ("GET", format!("/user-stories/{story_id}/attachments")),
            (
                "GET",
                format!("/story-attachments/{attachment_id}/download"),
            ),
            ("DELETE", format!("/story-attachments/{attachment_id}")),
        ] {
            let req = match method {
                "DELETE" => actix_test::TestRequest::delete(),
                _ => actix_test::TestRequest::get(),
            }
            .uri(&uri)
            .insert_header(("Authorization", other_auth.clone()))
            .to_request();
            let resp = actix_test::call_service(&app, req).await;
            assert_eq!(resp.status(), StatusCode::NOT_FOUND, "{method} {uri}");
        }

        // The owner deletes it, and it is gone.
        let req = actix_test::TestRequest::delete()
            .uri(&format!("/story-attachments/{attachment_id}"))
            .insert_header(("Authorization", owner_auth.clone()))
            .to_request();
        let resp = actix_test::call_service(&app, req).await;
        assert_eq!(resp.status(), StatusCode::OK, "owner's delete");

        let req = actix_test::TestRequest::get()
            .uri(&format!("/user-stories/{story_id}/attachments"))
            .insert_header(("Authorization", owner_auth))
            .to_request();
        let listed: serde_json::Value = actix_test::call_and_read_body_json(&app, req).await;
        assert_eq!(listed.as_array().map(Vec::len), Some(0));
    }
}
