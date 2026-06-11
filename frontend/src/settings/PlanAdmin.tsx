import { FormEvent, useCallback, useEffect, useState } from "react";
import { useAuth } from "../auth/useAuth";
import { hasPermission } from "../auth/permissions";
import {
  adminDeactivatePlan,
  adminListPlans,
  adminUpsertPlan,
  type Plan,
  type UpsertPlanInput,
} from "../api/billing";
import "./planAdmin.css";

// Bytes <-> GB helpers. The schema stores bytes (BIGINT); the admin form
// asks for a human-friendly GB number. The form is whole-GB only (no
// decimals), so a GB value rounds to the nearest gibibyte.
const BYTES_PER_GB = 1024 * 1024 * 1024;
const bytesToGB = (bytes: number) =>
  bytes <= 0 ? 0 : Math.round(bytes / BYTES_PER_GB);
const gbToBytes = (gb: number) => Math.round(gb) * BYTES_PER_GB;

// Same for cents <-> dollars on the price input. Whole-dollar only (no cents).
const centsToDollars = (cents: number) =>
  cents <= 0 ? 0 : Math.round(cents / 100);
const dollarsToCents = (dollars: number) => Math.round(dollars) * 100;

// Strip everything but digits so the number fields never accept a decimal
// point (or sign). Used by every numeric input's onChange.
const digitsOnly = (value: string) => value.replace(/[^0-9]/g, "");

// "Feature bullets" in the form are one-per-line free text. We persist
// them as a JSON object `{ "bullet text": true }` so the existing
// Pricing.tsx renderer (which iterates Object.entries) shows each line
// as a separate row. Round-trip preserves order on most browsers since
// modern JS object key iteration is insertion-ordered for string keys.
const featuresToText = (features: Record<string, unknown>): string =>
  Object.keys(features).join("\n");

const textToFeatures = (text: string): Record<string, true> => {
  const out: Record<string, true> = {};
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .forEach((line) => {
      out[line] = true;
    });
  return out;
};

type DraftForm = {
  code: string;
  name: string;
  description: string;
  audience: "personal" | "organization";
  stripe_price_id: string;
  // Numeric inputs are held as strings while editing so the field can be
  // cleared (empty) and accept in-progress values like "1." — binding them
  // to a `number` makes `Number("")` snap back to 0, which traps the cursor
  // and blocks typing a fresh value. They're coerced to numbers in
  // `draftToPayload`.
  amount_dollars: string;
  currency: string;
  billing_interval: string;
  storage_gb: string;
  seat_limit: string;
  features_text: string;
  is_active: boolean;
};

const EMPTY_DRAFT: DraftForm = {
  code: "",
  name: "",
  description: "",
  audience: "personal",
  stripe_price_id: "",
  amount_dollars: "",
  currency: "usd",
  billing_interval: "month",
  storage_gb: "",
  seat_limit: "",
  features_text: "",
  is_active: true,
};

const planToDraft = (plan: Plan): DraftForm => ({
  code: plan.code,
  name: plan.name,
  description: plan.description ?? "",
  audience: plan.audience,
  stripe_price_id: plan.stripe_price_id ?? "",
  // A 0/empty numeric renders as a blank field (with a placeholder) rather
  // than a literal "0" the admin has to delete before typing. Empty coerces
  // back to the right default in `draftToPayload`.
  amount_dollars: plan.amount_cents === 0 ? "" : String(centsToDollars(plan.amount_cents)),
  currency: plan.currency,
  billing_interval: plan.billing_interval,
  storage_gb:
    plan.storage_limit_bytes <= 0 ? "" : String(bytesToGB(plan.storage_limit_bytes)),
  seat_limit: plan.seat_limit <= 0 ? "" : String(plan.seat_limit),
  features_text: featuresToText(plan.features),
  is_active: plan.is_active,
});

const draftToPayload = (draft: DraftForm): UpsertPlanInput => ({
  code: draft.code.trim(),
  name: draft.name.trim(),
  description: draft.description.trim() || null,
  audience: draft.audience,
  stripe_price_id: draft.stripe_price_id.trim() || null,
  amount_cents: dollarsToCents(Number(draft.amount_dollars) || 0),
  currency: draft.currency.trim().toLowerCase() || "usd",
  billing_interval: draft.billing_interval,
  storage_limit_bytes: gbToBytes(Number(draft.storage_gb) || 0),
  seat_limit: Math.max(1, Math.trunc(Number(draft.seat_limit) || 1)),
  features: textToFeatures(draft.features_text),
  is_active: draft.is_active,
});

const fmtPrice = (plan: Plan): string => {
  if (plan.amount_cents === 0) return "Free";
  const dollars = (plan.amount_cents / 100).toFixed(2);
  return `${dollars} ${plan.currency.toUpperCase()} / ${plan.billing_interval}`;
};

const fmtStorage = (bytes: number): string => {
  // Render anything non-positive as "—". The schema default is 0 (no
  // quota set) and historical rows sometimes carry -1 as a legacy
  // "unlimited" sentinel; both should display the same way rather
  // than rounding to a misleading "-0 MB" via Number.toFixed.
  if (bytes <= 0) return "—";
  if (bytes >= BYTES_PER_GB * 1024)
    return `${(bytes / (BYTES_PER_GB * 1024)).toFixed(1)} TB`;
  if (bytes >= BYTES_PER_GB) return `${(bytes / BYTES_PER_GB).toFixed(0)} GB`;
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
};

export default function PlanAdmin() {
  const { user } = useAuth();
  const canManage = hasPermission(user, "billing:manage");

  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Editor state. `editingCode` distinguishes "creating new" (null)
  // from "editing existing" (a string), which controls whether the
  // Code input is locked (it's the upsert key).
  const [showForm, setShowForm] = useState(false);
  const [editingCode, setEditingCode] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftForm>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      const list = await adminListPlans();
      setPlans(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load plans");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (canManage) void reload();
  }, [canManage, reload]);

  // Auto-clear the success / error banners after a few seconds so the
  // user doesn't see stale state from a prior action.
  useEffect(() => {
    if (!success) return;
    const t = window.setTimeout(() => setSuccess(""), 4000);
    return () => window.clearTimeout(t);
  }, [success]);

  if (!canManage) {
    return (
      <div className="plan-admin">
        <h1>Plans</h1>
        <p className="plan-admin-empty">
          You don't have permission to manage plans. Ask a platform owner.
        </p>
      </div>
    );
  }

  const openCreate = () => {
    setEditingCode(null);
    setDraft(EMPTY_DRAFT);
    setShowForm(true);
  };

  const openEdit = (plan: Plan) => {
    setEditingCode(plan.code);
    setDraft(planToDraft(plan));
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingCode(null);
    setDraft(EMPTY_DRAFT);
  };

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    if (!draft.code.trim() || !draft.name.trim()) {
      setError("Code and Name are required");
      return;
    }
    setBusy(true);
    try {
      const saved = await adminUpsertPlan(draftToPayload(draft));
      setSuccess(`Plan "${saved.name}" saved`);
      closeForm();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save plan");
    } finally {
      setBusy(false);
    }
  };

  const deactivate = async (plan: Plan) => {
    const ok = window.confirm(
      `Deactivate plan "${plan.name}"? It will stop appearing on /pricing. Existing subscriptions are unaffected.`
    );
    if (!ok) return;
    setError("");
    try {
      await adminDeactivatePlan(plan.code);
      setSuccess(`Plan "${plan.name}" deactivated`);
      await reload();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to deactivate plan"
      );
    }
  };

  return (
    <div className="plan-admin">
      <header className="plan-admin-header">
        <div>
          <h1>Plans</h1>
          <p className="plan-admin-sub">
            Catalog shown to users on <code>/pricing</code>. Deactivated plans
            stay in the database for historical subscriptions but disappear from
            the public list.
          </p>
        </div>
        <button
          type="button"
          className="plan-admin-primary"
          onClick={openCreate}
        >
          + New plan
        </button>
      </header>

      {error && <div className="plan-admin-error">{error}</div>}
      {success && <div className="plan-admin-success">{success}</div>}

      {loading ? (
        <p className="plan-admin-empty">Loading…</p>
      ) : plans.length === 0 ? (
        <p className="plan-admin-empty">
          No plans yet. Click <strong>+ New plan</strong> to add one.
        </p>
      ) : (
        <table className="plan-admin-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Audience</th>
              <th>Price</th>
              <th>Storage</th>
              <th>Seats</th>
              <th>Status</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {plans.map((plan) => (
              <tr
                key={plan.code}
                className={plan.is_active ? "" : "is-inactive"}
              >
                <td>
                  <code>{plan.code}</code>
                </td>
                <td>{plan.name}</td>
                <td>{plan.audience}</td>
                <td>{fmtPrice(plan)}</td>
                <td>{fmtStorage(plan.storage_limit_bytes)}</td>
                <td>{plan.seat_limit}</td>
                <td>
                  {plan.is_active ? (
                    <span className="plan-pill plan-pill-active">Active</span>
                  ) : (
                    <span className="plan-pill plan-pill-inactive">Hidden</span>
                  )}
                </td>
                <td className="plan-admin-actions">
                  <button
                    type="button"
                    className="plan-admin-link"
                    onClick={() => openEdit(plan)}
                  >
                    Edit
                  </button>
                  {plan.is_active && (
                    <button
                      type="button"
                      className="plan-admin-link plan-admin-link-danger"
                      onClick={() => void deactivate(plan)}
                    >
                      Deactivate
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showForm && (
        <div
          className="plan-admin-modal-backdrop"
          role="dialog"
          aria-modal="true"
        >
          <form className="plan-admin-modal" onSubmit={submit}>
            <header className="plan-admin-modal-head">
              <h2>{editingCode ? `Edit "${editingCode}"` : "New plan"}</h2>
              <button
                type="button"
                className="plan-admin-modal-close"
                onClick={closeForm}
                aria-label="Close"
              >
                ×
              </button>
            </header>

            <div className="plan-admin-form-grid">
              <label>
                <span>Code</span>
                <input
                  value={draft.code}
                  onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                  placeholder="basic_user"
                  required
                  disabled={editingCode !== null}
                />
                <small>
                  Lowercase slug, no spaces. Immutable once created.
                </small>
              </label>

              <label>
                <span>Name</span>
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="Fluxze Plus"
                  required
                />
              </label>

              <label className="plan-admin-form-wide">
                <span>Notes (description)</span>
                <textarea
                  rows={2}
                  value={draft.description}
                  onChange={(e) =>
                    setDraft({ ...draft, description: e.target.value })
                  }
                  placeholder="Short paragraph shown under the plan name on /pricing."
                />
              </label>

              <label className="plan-admin-form-wide">
                <span>Feature bullets — one per line</span>
                <textarea
                  rows={4}
                  value={draft.features_text}
                  onChange={(e) =>
                    setDraft({ ...draft, features_text: e.target.value })
                  }
                  placeholder={
                    "End-to-end encrypted\n1 TB storage\nCustom domain"
                  }
                />
                <small>
                  Each non-empty line becomes a checkmark on the pricing card.
                </small>
              </label>

              <label>
                <span>Audience</span>
                <select
                  value={draft.audience}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      audience: e.target.value as "personal" | "organization",
                    })
                  }
                >
                  <option value="personal">Personal</option>
                  <option value="organization">Organization</option>
                </select>
              </label>

              <label>
                <span>Billing interval</span>
                <select
                  value={draft.billing_interval}
                  onChange={(e) =>
                    setDraft({ ...draft, billing_interval: e.target.value })
                  }
                >
                  <option value="month">Monthly</option>
                  <option value="year">Yearly</option>
                </select>
              </label>

              <label>
                <span>Price</span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  inputMode="numeric"
                  placeholder="0"
                  value={draft.amount_dollars}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      amount_dollars: digitsOnly(e.target.value),
                    })
                  }
                />
                <small>Whole dollars (or selected currency). 0 = free.</small>
              </label>

              <label>
                <span>Currency</span>
                <input
                  value={draft.currency}
                  onChange={(e) =>
                    setDraft({ ...draft, currency: e.target.value })
                  }
                  maxLength={3}
                  placeholder="usd"
                />
              </label>

              <label>
                <span>Storage (GB)</span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  inputMode="numeric"
                  placeholder="0"
                  value={draft.storage_gb}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      storage_gb: digitsOnly(e.target.value),
                    })
                  }
                />
                <small>0 = no quota. 1024 = 1 TB.</small>
              </label>

              <label>
                <span>Seat limit</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  placeholder="1"
                  value={draft.seat_limit}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      seat_limit: digitsOnly(e.target.value),
                    })
                  }
                />
              </label>

              <label className="plan-admin-form-wide">
                <span>Stripe price ID (optional)</span>
                <input
                  value={draft.stripe_price_id}
                  onChange={(e) =>
                    setDraft({ ...draft, stripe_price_id: e.target.value })
                  }
                  placeholder="price_1Ng…"
                />
                <small>
                  Paste from the Stripe dashboard to enable real checkout. Leave
                  blank to keep the plan as a catalog entry only.
                </small>
              </label>

              <label className="plan-admin-form-wide plan-admin-form-checkbox">
                <input
                  type="checkbox"
                  checked={draft.is_active}
                  onChange={(e) =>
                    setDraft({ ...draft, is_active: e.target.checked })
                  }
                />
                <span>Active — shown on /pricing</span>
              </label>
            </div>

            <footer className="plan-admin-modal-foot">
              <button
                type="button"
                className="plan-admin-link"
                onClick={closeForm}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="plan-admin-primary"
                disabled={busy}
              >
                {busy
                  ? "Saving…"
                  : editingCode
                    ? "Save changes"
                    : "Create plan"}
              </button>
            </footer>
          </form>
        </div>
      )}
    </div>
  );
}
