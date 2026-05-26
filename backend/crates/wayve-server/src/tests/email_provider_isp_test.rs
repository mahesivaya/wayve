#[cfg(test)]
mod tests {
    use actix_web::HttpResponse;
    use anyhow::Result;
    use async_trait::async_trait;
    use std::sync::Arc;

    use crate::email::outlook::OutlookCredentials;
    use crate::email::provider::{
        GoogleMailClient, GoogleOAuthClient, MailProviderClient, MailRead, MailSender, MailSync,
        OutlookMailClient, RefreshedEmailToken, TokenRefresher,
    };
    use crate::models::email_request::SendEmailRequest;

    // Stub that implements ONLY MailSender. The whole point of the ISP split:
    // a caller that just needs to send mail should not be forced to define
    // sync/sync_before/mark_read/refresh_token.
    struct SendOnlyStub;

    #[async_trait]
    impl MailSender for SendOnlyStub {
        async fn send(
            &self,
            _access_token: &str,
            _from_email: &str,
            _account_id: i32,
            _data: &SendEmailRequest,
            _user_id: i32,
        ) -> HttpResponse {
            HttpResponse::Ok().finish()
        }
    }

    fn takes_sender(_s: &dyn MailSender) {}
    fn takes_refresher(_s: &dyn TokenRefresher) {}
    fn takes_sync(_s: &dyn MailSync) {}
    fn takes_read(_s: &dyn MailRead) {}

    #[test]
    fn isp_send_only_stub_is_a_mail_sender() {
        let stub = SendOnlyStub;
        takes_sender(&stub);
    }

    // Real provider clients satisfy each narrow trait individually — the
    // umbrella `MailProviderClient` is just `TokenRefresher + MailSync +
    // MailSender + MailRead`. These assertions are compile-time only;
    // if the supertrait bounds drift, the test won't compile.
    #[test]
    fn google_client_implements_each_narrow_trait() {
        let g = GoogleMailClient {
            oauth: GoogleOAuthClient {
                client_id: "x".into(),
                client_secret: "y".into(),
            },
        };
        takes_refresher(&g);
        takes_sync(&g);
        takes_sender(&g);
        takes_read(&g);
    }

    #[test]
    fn outlook_client_implements_each_narrow_trait() {
        let o = OutlookMailClient {
            creds: OutlookCredentials {
                client_id: "x".into(),
                client_secret: "y".into(),
                redirect_uri: "https://example.com/cb".into(),
            },
        };
        takes_refresher(&o);
        takes_sync(&o);
        takes_sender(&o);
        takes_read(&o);
    }

    // Compile-time proof that `Arc<dyn MailProviderClient>` is still callable
    // through each narrow trait via supertrait method dispatch (the existing
    // call sites in routes/sync code rely on this).
    #[test]
    fn umbrella_arc_remains_usable() {
        fn _assert_send_via_umbrella(_c: Arc<dyn MailProviderClient>) {
            // We don't call .send/.sync here (no runtime fixtures); the goal
            // is purely that the trait object compiles with the supertrait
            // constraints intact.
        }
        // Stub of the umbrella for compile-time exercise.
        struct FullStub;

        #[async_trait]
        impl TokenRefresher for FullStub {
            async fn refresh_token(&self, _refresh_token: &str) -> Result<RefreshedEmailToken> {
                Ok(RefreshedEmailToken {
                    access_token: "t".into(),
                    refresh_token: None,
                })
            }
        }

        #[async_trait]
        impl MailSync for FullStub {
            async fn sync(
                &self,
                _pool: &sqlx::PgPool,
                _account_id: i32,
                _access_token: &str,
                _last_sync: Option<i64>,
            ) -> Result<()> {
                Ok(())
            }

            async fn sync_before(
                &self,
                _pool: &sqlx::PgPool,
                _account_id: i32,
                _access_token: &str,
                _before_timestamp: i64,
                _limit: usize,
            ) -> Result<()> {
                Ok(())
            }
        }

        #[async_trait]
        impl MailSender for FullStub {
            async fn send(
                &self,
                _access_token: &str,
                _from_email: &str,
                _account_id: i32,
                _data: &SendEmailRequest,
                _user_id: i32,
            ) -> HttpResponse {
                HttpResponse::Ok().finish()
            }
        }

        #[async_trait]
        impl MailRead for FullStub {
            async fn mark_read(
                &self,
                _access_token: &str,
                _provider_message_id: &str,
            ) -> Result<()> {
                Ok(())
            }
        }

        impl MailProviderClient for FullStub {
            fn provider(&self) -> crate::email::provider::MailProvider {
                crate::email::provider::MailProvider::Google
            }
        }

        let arc: Arc<dyn MailProviderClient> = Arc::new(FullStub);
        _assert_send_via_umbrella(arc);
    }
}
