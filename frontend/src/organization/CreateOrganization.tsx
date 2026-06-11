import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import {
  finalizeOrgSignup,
  orgSignupIntent,
  type CreatedMyOrganization,
} from "../api/admin";
import {
  createPaymentMethodSetupIntent,
  getDefaultPaymentMethod,
  getStripeStatus,
  setDefaultPaymentMethod,
  type DefaultCard,
} from "../api/billing";
import "./createOrganization.css";

const STRIPE_JS_URL = "https://js.stripe.com/v3/";

function loadStripeScript(): Promise<void> {
  if (window.Stripe) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${STRIPE_JS_URL}"]`
    );
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error("Stripe.js failed to load")),
        { once: true }
      );
      return;
    }
    const script = document.createElement("script");
    script.src = STRIPE_JS_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Stripe.js failed to load"));
    document.head.appendChild(script);
  });
}

type PaymentChoice = "saved" | "new";

/**
 * Self-serve, payment-gated organization creation. A personal user fills the
 * org details + admin email and pays in one form; the organization is created
 * only after the charge succeeds (server-side, via /organizations/signup-intent
 * → /organizations/finalize). On success they're sent to the recovery-key
 * bootstrap page, exactly as before.
 *
 * Payment section:
 *   - An Advance user (saved card) sees a "Use saved card" radio (default) plus
 *     "New payment method".
 *   - A Basic user (no saved card) sees the new-card form directly.
 * A new card is collected via a SetupIntent Payment Element shown inline; on
 * submit it's saved + set as default, then charged as the org plan's first
 * invoice.
 */
export default function CreateOrganization() {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const intendedPlan = params.get("plan") || "";

  const [name, setName] = useState("");
  const [place, setPlace] = useState("");
  const [adminEmail, setAdminEmail] = useState(user?.email ?? "");

  const [defaultCard, setDefaultCard] = useState<DefaultCard | null>(null);
  const [paymentChoice, setPaymentChoice] = useState<PaymentChoice>("new");
  const [billingReady, setBillingReady] = useState(false);
  const [billingConfigured, setBillingConfigured] = useState(true);
  const [cardFormReady, setCardFormReady] = useState(false);
  const [cardMessage, setCardMessage] = useState("");

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  const publishableKey = useRef<string | null>(null);
  const stripeRef = useRef<StripeInstance | null>(null);
  const elementsRef = useRef<StripeElements | null>(null);
  const paymentElementRef = useRef<StripePaymentElement | null>(null);

  const isPersonal = (user?.account_type ?? "personal") === "personal";

  // Load billing context: publishable key + any saved default card.
  useEffect(() => {
    if (!isPersonal) return;
    let cancelled = false;
    void (async () => {
      try {
        const [status, card] = await Promise.all([
          getStripeStatus(),
          getDefaultPaymentMethod().catch(() => ({ default: null })),
        ]);
        if (cancelled) return;
        const key = status.publishable_key;
        const configured = status.configured && !!key && key.startsWith("pk_");
        publishableKey.current = configured ? key : null;
        setBillingConfigured(configured);
        setDefaultCard(card.default);
        // Default to the saved card when present; otherwise collect a new one.
        setPaymentChoice(card.default ? "saved" : "new");
      } catch {
        if (!cancelled) {
          setBillingConfigured(false);
        }
      } finally {
        if (!cancelled) setBillingReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isPersonal]);

  const teardownCardForm = useCallback(() => {
    paymentElementRef.current?.destroy();
    paymentElementRef.current = null;
    elementsRef.current = null;
    setCardFormReady(false);
  }, []);

  // Mount a SetupIntent Payment Element whenever the "new payment method"
  // option is active. Collecting the card via a SetupIntent lets us show the
  // form inline (before submit) and charge it after it's saved.
  useEffect(() => {
    if (!isPersonal || !billingReady || !billingConfigured) return;
    // Switching away from "new" doesn't need an explicit teardown here: the
    // previous run's cleanup already destroyed the element when the deps
    // changed, and the #org-card-element node is unmounted with the form.
    if (paymentChoice !== "new") return;
    let cancelled = false;
    void (async () => {
      try {
        setCardMessage("");
        const key = publishableKey.current;
        if (!key) throw new Error("Billing is not configured");
        const [{ client_secret: clientSecret }] = await Promise.all([
          createPaymentMethodSetupIntent(),
          loadStripeScript(),
        ]);
        if (cancelled) return;
        const stripe = window.Stripe?.(key) ?? null;
        if (!stripe) throw new Error("Stripe could not initialize");
        const isDark =
          document.documentElement.getAttribute("data-theme") === "dark";
        const elements = stripe.elements({
          clientSecret,
          appearance: { theme: isDark ? "night" : "stripe" },
        });
        const paymentElement = elements.create("payment", { layout: "tabs" });
        paymentElement.on("change", (event) =>
          setCardMessage(event.error?.message ?? "")
        );
        paymentElement.on("ready", () => setCardFormReady(true));
        paymentElement.mount("#org-card-element");
        stripeRef.current = stripe;
        elementsRef.current = elements;
        paymentElementRef.current = paymentElement;
      } catch (err) {
        if (!cancelled) {
          setCardMessage(
            err instanceof Error ? err.message : "Could not load the card form"
          );
        }
      }
    })();
    return () => {
      cancelled = true;
      teardownCardForm();
    };
  }, [
    isPersonal,
    billingReady,
    billingConfigured,
    paymentChoice,
    teardownCardForm,
  ]);

  const goToBootstrap = useCallback(
    async (org: CreatedMyOrganization) => {
      await refresh();
      const planSuffix = intendedPlan
        ? `&plan=${encodeURIComponent(intendedPlan)}`
        : "";
      void navigate(
        `/organization/recovery-key/bootstrap?org=${org.organization_id}${planSuffix}`,
        { replace: true }
      );
    },
    [refresh, intendedPlan, navigate]
  );

  const submitOrg = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreateError("");

    if (!name.trim()) {
      setCreateError("Enter an organization name.");
      return;
    }
    if (!adminEmail.trim().includes("@")) {
      setCreateError("Enter a valid admin email address.");
      return;
    }
    if (!billingConfigured) {
      setCreateError("Billing is not configured, so payment can't be taken.");
      return;
    }

    setCreating(true);
    try {
      // New card: confirm the SetupIntent to attach + set it as the default,
      // so the signup-intent "saved" path can charge it.
      if (paymentChoice === "new") {
        const stripe = stripeRef.current;
        const elements = elementsRef.current;
        if (!stripe || !elements) {
          throw new Error("The card form isn't ready yet.");
        }
        const setupRes = await stripe.confirmSetup({
          elements,
          confirmParams: { return_url: window.location.href },
          redirect: "if_required",
        });
        if (setupRes.error) {
          throw new Error(setupRes.error.message ?? "Could not save the card.");
        }
        const pm = setupRes.setupIntent?.payment_method;
        const pmId = typeof pm === "string" ? pm : pm?.id;
        if (pmId) {
          await setDefaultPaymentMethod(pmId);
        }
      }

      const result = await orgSignupIntent({
        name: name.trim(),
        place: place.trim() || undefined,
        admin_email: adminEmail.trim() || undefined,
        payment_choice: "saved",
        plan_code: intendedPlan || undefined,
      });

      const org =
        result.kind === "created"
          ? result.org
          : await finalizeOrgSignup(result.pending_id);

      await goToBootstrap(org);
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : "Failed to create organization"
      );
      setCreating(false);
    }
  };

  // Guard: only personal users may self-serve a new org.
  if (!isPersonal) {
    return (
      <div className="create-org-page">
        <div className="create-org-card">
          <h1>Organization setup</h1>
          <p>
            Your account already belongs to an organization or platform scope,
            so you can't create a new organization from here.
          </p>
          <button
            type="button"
            className="create-org-primary"
            onClick={() => navigate("/")}
          >
            Back to home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="create-org-page">
      <section className="create-org-card">
        <header className="create-org-header">
          <h1>Create your organization</h1>
          <p>
            Organization plans cover the whole team — shared inboxes,
            multi-seat, billing rollup. You'll become the organization's owner;
            your existing emails, chats, and files stay on this account. Your
            organization is created once payment succeeds.
          </p>
        </header>
        <form className="create-org-form" onSubmit={submitOrg}>
          <label className="create-org-label">
            <span>Organization name</span>
            <input
              required
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Acme Inc."
              autoFocus
            />
          </label>
          <label className="create-org-label">
            <span>
              Place <small>(optional — city, country, or address)</small>
            </span>
            <input
              maxLength={200}
              value={place}
              onChange={(event) => setPlace(event.target.value)}
              placeholder="e.g. San Francisco, CA"
            />
          </label>
          <label className="create-org-label">
            <span>Admin email</span>
            <input
              type="email"
              required
              maxLength={254}
              value={adminEmail}
              onChange={(event) => setAdminEmail(event.target.value)}
              placeholder="admin@yourcompany.com"
            />
          </label>
          <p className="create-org-hint">
            Defaults to your account email — change it if a different address
            should be the organization's admin contact.
          </p>

          <fieldset className="create-org-payment">
            <legend>Payment</legend>
            {!billingReady && (
              <p className="create-org-empty">Loading payment options…</p>
            )}
            {billingReady && !billingConfigured && (
              <p className="create-org-warning">
                Billing isn't configured in this environment, so the
                organization can't be created here.
              </p>
            )}
            {billingReady && billingConfigured && (
              <>
                {defaultCard && (
                  <>
                    {/* Default to the card already on file; only reveal the
                        new-card form if the user opts to use a different one. */}
                    <p className="create-org-pay-option create-org-pay-saved">
                      Use saved card —{" "}
                      <strong>
                        {defaultCard.brand.toUpperCase()} ••••{" "}
                        {defaultCard.last4}
                      </strong>
                    </p>
                    <label className="create-org-pay-option create-org-pay-option--toggle">
                      <input
                        type="checkbox"
                        checked={paymentChoice === "new"}
                        onChange={(event) =>
                          setPaymentChoice(
                            event.target.checked ? "new" : "saved"
                          )
                        }
                      />
                      <span>Use a different card</span>
                    </label>
                  </>
                )}
                {paymentChoice === "new" && (
                  <div className="create-org-card-fields">
                    <div id="org-card-element" />
                    {!cardFormReady && (
                      <p className="create-org-empty">Loading card form…</p>
                    )}
                    {cardMessage && (
                      <p className="create-org-error">{cardMessage}</p>
                    )}
                  </div>
                )}
              </>
            )}
          </fieldset>

          <p className="create-org-note">
            Your account becomes the organization's owner. You can revert to a
            personal account later from the organization home page.
          </p>
          {createError && <p className="create-org-error">{createError}</p>}
          <div className="create-org-actions">
            <button
              type="submit"
              className="create-org-primary"
              disabled={
                creating ||
                !name.trim() ||
                !billingConfigured ||
                (paymentChoice === "new" && !cardFormReady)
              }
            >
              {creating ? "Processing payment…" : "Create organization"}
            </button>
            <button
              type="button"
              className="create-org-secondary"
              disabled={creating}
              onClick={() => navigate("/billing")}
            >
              Cancel
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
