use crate::prelude::*;
use chrono::{DateTime, Utc};

/// A billing owner is polymorphic: either an individual user (personal
/// billing) or a whole organization (organization billing).
#[derive(Debug, Clone, Copy)]
pub enum BillingOwner {
    User(i32),
    Organization(i32),
}

impl BillingOwner {
    pub fn user_id(&self) -> Option<i32> {
        match self {
            BillingOwner::User(id) => Some(*id),
            BillingOwner::Organization(_) => None,
        }
    }

    pub fn organization_id(&self) -> Option<i32> {
        match self {
            BillingOwner::Organization(id) => Some(*id),
            BillingOwner::User(_) => None,
        }
    }

    /// Discriminator used in API payloads and the `plans.audience` column.
    pub fn kind(&self) -> &'static str {
        match self {
            BillingOwner::User(_) => "personal",
            BillingOwner::Organization(_) => "organization",
        }
    }

    pub fn is_organization(&self) -> bool {
        matches!(self, BillingOwner::Organization(_))
    }
}

#[derive(Debug, Serialize, FromRow)]
pub struct Plan {
    pub id: i32,
    pub code: String,
    pub name: String,
    pub description: Option<String>,
    pub audience: String,
    /// Sub-tier within the audience (`personal` | `startups` | `business` |
    /// `enterprise`). Distinguishes Business from Enterprise org plans.
    pub tier: String,
    pub stripe_price_id: Option<String>,
    pub amount_cents: i64,
    pub currency: String,
    pub billing_interval: String,
    pub storage_limit_bytes: i64,
    pub seat_limit: i32,
    pub features: Value,
    pub is_active: bool,
}

#[derive(Debug, Serialize, FromRow)]
pub struct Invoice {
    pub id: i32,
    pub stripe_invoice_id: String,
    pub amount_due_cents: i64,
    pub amount_paid_cents: i64,
    pub currency: String,
    pub status: String,
    pub hosted_invoice_url: Option<String>,
    pub invoice_pdf: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct Entitlement {
    pub plan_code: Option<String>,
    pub storage_limit_bytes: i64,
    pub seat_limit: i32,
    pub features: Value,
    pub active: bool,
}

#[derive(Deserialize)]
pub struct CheckoutInput {
    pub plan_code: String,
    pub autopay: Option<bool>,
}

#[derive(Deserialize)]
pub struct DefaultPaymentMethodInput {
    pub payment_method_id: String,
}

#[derive(Deserialize)]
pub struct RecordUsageInput {
    pub metric: String,
    pub quantity: i64,
}

#[derive(Deserialize)]
pub struct CreatePlanInput {
    pub code: String,
    pub name: String,
    pub description: Option<String>,
    pub audience: Option<String>,
    /// Optional tier; defaults to `personal` when omitted. Validated against
    /// `personal | startups | business | enterprise` in `admin_create_plan`.
    pub tier: Option<String>,
    pub stripe_price_id: Option<String>,
    pub amount_cents: Option<i64>,
    pub currency: Option<String>,
    pub billing_interval: Option<String>,
    pub storage_limit_bytes: Option<i64>,
    pub seat_limit: Option<i32>,
    /// Free-form bullet list of feature notes the admin wants to surface
    /// on /pricing. Stored as JSONB `{bullet1: true, bullet2: true}` so
    /// the existing Pricing.tsx renderer (which does `Object.entries`)
    /// keeps working with no further changes.
    pub features: Option<Value>,
    /// Optional — when not provided, plan is (re)activated on upsert as
    /// the historical default. Pass `false` to keep an existing plan
    /// hidden from /pricing without losing the row.
    pub is_active: Option<bool>,
}
