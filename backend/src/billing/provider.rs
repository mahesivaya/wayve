// Stripe provider seam. A thin hand-rolled client over reqwest (the same
// approach the project uses for Gmail/Graph/Zoom) so tests can point
// STRIPE_API_BASE at a wiremock server. Stripe stays the source of truth;
// everything here is request/response plumbing + webhook signature checks.

use crate::prelude::*;
use anyhow::anyhow;
use hmac::{Hmac, Mac};
use sha2::Sha256;

// Same rationale as `email::oauth::HTTP_CLIENT`: cap connect + total request
// time so a stalled Stripe response can't park an async worker forever.
static HTTP: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap()
});

/// Secret API key (`sk_...`). Absent in dev/test environments without Stripe.
pub fn secret_key() -> Option<String> {
    crate::config::stripe().secret_key
}

/// Webhook signing secret (`whsec_...`).
pub fn webhook_secret() -> Option<String> {
    crate::config::stripe().webhook_secret
}

/// API root. Overridable in tests via STRIPE_API_BASE (wiremock).
pub fn api_base() -> String {
    crate::config::stripe().api_base
}

pub fn is_configured() -> bool {
    secret_key().is_some()
}

pub fn publishable_key() -> Option<String> {
    crate::config::stripe().publishable_key
}

pub fn is_test_mode() -> bool {
    secret_key()
        .or_else(publishable_key)
        .map(|key| key.starts_with("sk_test_") || key.starts_with("pk_test_"))
        .unwrap_or(false)
}

async fn post_form(path: &str, params: &[(&str, String)]) -> Result<Value> {
    let key = secret_key().ok_or_else(|| anyhow!("STRIPE_SECRET_KEY not configured"))?;
    let url = format!("{}/v1{}", api_base(), path);
    let resp = HTTP.post(&url).bearer_auth(key).form(params).send().await?;
    let status = resp.status();
    let body: Value = resp.json().await?;
    if !status.is_success() {
        return Err(anyhow!("stripe {path} returned {status}: {body}"));
    }
    Ok(body)
}

/// Create a Stripe customer; returns the new `cus_...` id.
pub async fn create_customer(email: &str, owner_label: &str) -> Result<String> {
    let params = vec![
        ("email", email.to_string()),
        ("metadata[owner]", owner_label.to_string()),
    ];
    let body = post_form("/customers", &params).await?;
    body.get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| anyhow!("stripe customer response missing id"))
}

pub struct CheckoutParams {
    pub customer_id: String,
    pub price_id: String,
    pub success_url: String,
    pub cancel_url: String,
    pub client_reference: String,
    pub autopay: bool,
}

pub struct CheckoutSession {
    pub id: String,
    pub url: String,
}

/// Create a hosted Checkout Session for a subscription.
pub async fn create_checkout_session(p: &CheckoutParams) -> Result<CheckoutSession> {
    let params = vec![
        ("mode", "subscription".to_string()),
        ("customer", p.customer_id.clone()),
        ("line_items[0][price]", p.price_id.clone()),
        ("line_items[0][quantity]", "1".to_string()),
        ("success_url", p.success_url.clone()),
        ("cancel_url", p.cancel_url.clone()),
        ("client_reference_id", p.client_reference.clone()),
        (
            "payment_method_collection",
            if p.autopay { "if_required" } else { "always" }.to_string(),
        ),
    ];
    let body = post_form("/checkout/sessions", &params).await?;
    let id = body
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("checkout session missing id"))?;
    let url = body
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("checkout session missing url"))?;
    Ok(CheckoutSession {
        id: id.to_string(),
        url: url.to_string(),
    })
}

/// Create a Customer Portal session; returns the URL to redirect the user to.
pub async fn create_portal_session(customer_id: &str, return_url: &str) -> Result<String> {
    let params = vec![
        ("customer", customer_id.to_string()),
        ("return_url", return_url.to_string()),
    ];
    let body = post_form("/billing_portal/sessions", &params).await?;
    body.get("url")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| anyhow!("portal session missing url"))
}

/// Schedule cancellation of a subscription at the end of the current period.
pub async fn cancel_at_period_end(subscription_id: &str) -> Result<()> {
    let params = vec![("cancel_at_period_end", "true".to_string())];
    post_form(&format!("/subscriptions/{subscription_id}"), &params).await?;
    Ok(())
}

/// Verify a Stripe `Stripe-Signature` header against the raw request body.
/// Header form: `t=<unix>,v1=<hex hmac>,v1=<hex hmac>...`.
pub fn verify_webhook_signature(payload: &[u8], sig_header: &str, secret: &str) -> bool {
    let mut timestamp: Option<&str> = None;
    let mut signatures: Vec<&str> = Vec::new();
    for part in sig_header.split(',') {
        let mut kv = part.splitn(2, '=');
        match (kv.next(), kv.next()) {
            (Some("t"), Some(value)) => timestamp = Some(value),
            (Some("v1"), Some(value)) => signatures.push(value),
            _ => {}
        }
    }
    let Some(ts) = timestamp else {
        return false;
    };

    let mut mac = match Hmac::<Sha256>::new_from_slice(secret.as_bytes()) {
        Ok(mac) => mac,
        Err(_) => return false,
    };
    mac.update(ts.as_bytes());
    mac.update(b".");
    mac.update(payload);
    let expected = hex_encode(&mac.finalize().into_bytes());

    signatures
        .iter()
        .any(|candidate| constant_time_eq(candidate.as_bytes(), expected.as_bytes()))
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}
