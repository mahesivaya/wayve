import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  cancelSubscription,
  createPaymentMethodSetupIntent,
  getEntitlements,
  getOrganizationBilling,
  getStripeStatus,
  getSubscription,
  getUsage,
  listInvoices,
  listPlans,
  setDefaultPaymentMethod,
  startInlineSubscription,
  type Entitlements,
  type Invoice,
  type OrganizationBilling,
  type Plan,
  type StripeStatus,
  type SubscriptionResponse,
  type UsageResponse,
} from "../api/billing";
import { invalidateGetCache } from "../api/client";
import { cachedLoad } from "../api/cache";
import { getFeatureAccess } from "../api/featureAccess";
import { useAuth } from "../auth/useAuth";
import { fmtShortDate } from "../utils/datetime";
import { PLAN_COPY, PLAN_DISPLAY_ORDER, planName } from "./planCatalog";
import "./billing.css";

const BYTES_IN_GB = 1024 * 1024 * 1024;
const UNLIMITED_STORAGE = -1;

// Plan titles come from the DB `name` column. This map is an escape hatch for
// display-only renames.
const PLAN_TITLE: Record<string, string> = {};

function planDisplayRank(plan: Plan): number {
  const codeRank = PLAN_DISPLAY_ORDER.indexOf(plan.code);
  if (codeRank >= 0) return codeRank;
  const nameRank = PLAN_DISPLAY_ORDER.findIndex(
    (code) => plan.name.toLowerCase().replace(/\s+/g, "_") === code
  );
  return nameRank >= 0 ? nameRank : PLAN_DISPLAY_ORDER.length;
}

const STRIPE_TEST_CARDS = [
  {
    label: "Visa credit",
    number: "4242 4242 4242 4242",
    result: "Successful payment",
  },
  {
    label: "Visa debit",
    number: "4000 0566 5566 5556",
    result: "Successful debit payment",
  },
  {
    label: "Requires auth",
    number: "4000 0025 0000 3155",
    result: "3D Secure challenge",
  },
  { label: "Declined", number: "4000 0000 0000 9995", result: "Decline test" },
];

const STRIPE_JS_URL = "https://js.stripe.com/v3/";

function formatMoney(cents: number | null, currency: string | null): string {
  if (cents == null) return "—";
  return `${(cents / 100).toFixed(2)} ${(currency ?? "usd").toUpperCase()}`;
}

function formatBytes(bytes: number): string {
  if (bytes === UNLIMITED_STORAGE) return "Unlimited";
  if (bytes >= BYTES_IN_GB) return `${(bytes / BYTES_IN_GB).toFixed(1)} GB`;
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

function formatDate(value: string | null): string {
  return fmtShortDate(value);
}

// Billing history is one row per month, so charges are labelled by month
// ("June 2026") rather than by exact day.
function formatMonth(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fmtShortDate(value);
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

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
        {
          once: true,
        }
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

function BillingInner() {
  const { user, refresh } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();

  const [plans, setPlans] = useState<Plan[]>([]);
  const [sub, setSub] = useState<SubscriptionResponse | null>(null);
  const [entitlements, setEntitlements] = useState<Entitlements | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [org, setOrg] = useState<OrganizationBilling | null>(null);
  const [stripeStatus, setStripeStatus] = useState<StripeStatus | null>(null);
  const [autopay, setAutopay] = useState(true);
  const [paymentFormOpen, setPaymentFormOpen] = useState(false);
  const [paymentFormReady, setPaymentFormReady] = useState(false);
  const [paymentMessage, setPaymentMessage] = useState("");
  const [paymentSuccess, setPaymentSuccess] = useState("");

  // The inline-subscription Payment Element needs its own Element tree,
  // separate from the payment-method form above: one confirms a SetupIntent
  // (saving a card) and the other a PaymentIntent (charging the first
  // invoice), and Elements can't swap intent types on an existing mount.
  const [subscribeFormOpen, setSubscribeFormOpen] = useState(false);
  const [subscribeFormReady, setSubscribeFormReady] = useState(false);
  const [subscribeMessage, setSubscribeMessage] = useState("");
  const [subscribePlan, setSubscribePlan] = useState<Plan | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const setupClientSecret = useRef("");
  const paymentElementRef = useRef<StripePaymentElement | null>(null);
  const elementsRef = useRef<StripeElements | null>(null);
  const stripeRef = useRef<StripeInstance | null>(null);
  const subscribeClientSecret = useRef("");
  const subscribePaymentElementRef = useRef<StripePaymentElement | null>(null);
  const subscribeElementsRef = useRef<StripeElements | null>(null);
  const subscribeStripeRef = useRef<StripeInstance | null>(null);
  // Stripe.js is initialized once at mount so clicking Subscribe doesn't pay
  // the script-download cost (~200-500ms on the first attempt).
  const preloadedStripeRef = useRef<StripeInstance | null>(null);
  const subscribePanelRef = useRef<HTMLElement | null>(null);

  const checkoutStatus = params.get("checkout");

  // `useCache` defaults to false so every post-mutation reload fetches fresh.
  // Only the initial mount opts into the short-lived cache, which avoids the
  // six-request refetch when navigating back to Billing.
  const reload = useCallback(async (useCache = false) => {
    setError("");
    try {
      const [planList, subscription, ent, invoiceList, usageData, stripe] =
        await cachedLoad("billing", useCache ? 8000 : 0, () =>
          Promise.all([
            listPlans(),
            getSubscription(),
            getEntitlements(),
            listInvoices(),
            getUsage(),
            getStripeStatus(),
          ])
        );
      setPlans(planList);
      setSub(subscription);
      setEntitlements(ent);
      setInvoices(invoiceList);
      setUsage(usageData);
      setStripeStatus(stripe);
      if (subscription.owner_type === "organization") {
        try {
          setOrg(await getOrganizationBilling());
        } catch {
          setOrg(null);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load billing");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void reload(true);
    }, 0);

    return () => window.clearTimeout(timer);
  }, [reload]);

  // Plan/limit/status are cached in three places after an upgrade: the frontend
  // GET cache, the global auth user (`current_plan`), and this page's data. All
  // three must refetch so Settings, the plan badge, and the storage banner
  // agree. Stripe's activation webhook is async, so callers schedule more than
  // one attempt.
  const refreshAfterUpgrade = useCallback(async () => {
    invalidateGetCache();
    await Promise.allSettled([reload(), refresh()]);
  }, [reload, refresh]);

  // Warm up Stripe.js as soon as the publishable key is known, so a later
  // Subscribe click only pays the backend round-trip and iframe handshake.
  useEffect(() => {
    const publishableKey = stripeStatus?.publishable_key;
    if (!publishableKey || !publishableKey.startsWith("pk_")) return;
    if (preloadedStripeRef.current) return;

    let cancelled = false;
    void (async () => {
      try {
        await loadStripeScript();
        if (cancelled) return;
        preloadedStripeRef.current = window.Stripe?.(publishableKey) ?? null;
      } catch {
        // Best-effort: subscribe() retries the load on click.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [stripeStatus]);

  const ownerType = sub?.owner_type ?? "personal";

  // After a successful organization checkout the owner lands on their
  // workspace dashboard; personal checkouts stay on /billing. The delay lets
  // the success banner show before navigating away.
  useEffect(() => {
    if (loading) return;
    if (checkoutStatus !== "success") return;
    if (ownerType !== "organization") return;
    const handle = window.setTimeout(() => {
      void navigate("/organization/home", { replace: true });
    }, 1500);
    return () => window.clearTimeout(handle);
  }, [loading, checkoutStatus, ownerType, navigate]);

  // Returning from a successful checkout refreshes plan-derived data. The retry
  // covers Stripe's activation webhook not having landed on the first fetch.
  useEffect(() => {
    if (checkoutStatus !== "success") return;
    void refreshAfterUpgrade();
    const retry = window.setTimeout(() => void refreshAfterUpgrade(), 4000);
    return () => window.clearTimeout(retry);
  }, [checkoutStatus, refreshAfterUpgrade]);

  const currentPlanCode = sub?.subscription?.plan_code ?? null;
  // A personal account with no subscription row is implicitly on the free Basic
  // tier, so name it explicitly and the card renders as "Active".
  const effectiveCurrentCode =
    currentPlanCode ?? (ownerType === "personal" ? "basic_user" : null);
  const hasPaidPlan = (sub?.subscription?.amount_cents ?? 0) > 0;
  // Organizations get a focused billing view instead of the personal
  // plan-selection + usage layout.
  const isOrg = ownerType === "organization";

  const clearSubscribeElements = useCallback(() => {
    subscribePaymentElementRef.current?.destroy();
    subscribePaymentElementRef.current = null;
    subscribeElementsRef.current = null;
    subscribeStripeRef.current = null;
    subscribeClientSecret.current = "";
    setSubscribeFormReady(false);
  }, []);

  // Creates the subscription server-side in `incomplete` state and mounts a
  // Payment Element bound to the latest invoice's PaymentIntent. Confirmation
  // happens locally via stripe.confirmPayment — no redirect to checkout.stripe.com.
  const subscribe = async (plan: Plan) => {
    setBusy(`plan:${plan.code}`);
    setError("");
    setSubscribeMessage("");
    setPaymentSuccess("");
    // Mutually exclusive with the payment-method form so two Element trees
    // don't compete for focus or a stale clientSecret.
    if (paymentFormOpen) {
      setPaymentFormOpen(false);
      clearPaymentElements();
    }
    setSubscribePlan(plan);
    setSubscribeFormOpen(true);
    // Scroll on the next frame, once React has committed the show-panel render.
    window.requestAnimationFrame(() => {
      subscribePanelRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });

    try {
      const publishableKey =
        stripeStatus?.publishable_key ??
        (() => {
          throw new Error("Stripe publishable key is not configured");
        })();
      if (!publishableKey.startsWith("pk_")) {
        throw new Error("Stripe publishable key is not configured");
      }

      // Prefer the warmed-up instance; fall back to a fresh load if the preload
      // hasn't finished or failed.
      let stripe = preloadedStripeRef.current;
      const [intent] = await Promise.all([
        startInlineSubscription(plan.code, autopay),
        stripe ? Promise.resolve() : loadStripeScript(),
      ]);
      if (!stripe) {
        stripe = window.Stripe?.(publishableKey) ?? null;
        if (stripe) preloadedStripeRef.current = stripe;
      }
      if (!stripe) throw new Error("Stripe could not initialize");

      const isDark =
        document.documentElement.getAttribute("data-theme") === "dark";
      const elements = stripe.elements({
        clientSecret: intent.client_secret,
        appearance: { theme: isDark ? "night" : "stripe" },
      });
      const paymentElement = elements.create("payment", {
        layout: "tabs",
        fields: { billingDetails: "auto" },
      });
      paymentElement.on("change", (event) => {
        setSubscribeMessage(event.error?.message ?? "");
      });
      paymentElement.on("ready", () => setSubscribeFormReady(true));
      paymentElement.mount("#billing-subscribe-element");

      subscribeClientSecret.current = intent.client_secret;
      subscribeStripeRef.current = stripe;
      subscribeElementsRef.current = elements;
      subscribePaymentElementRef.current = paymentElement;
    } catch (err) {
      clearSubscribeElements();
      setSubscribeFormOpen(false);
      setSubscribePlan(null);
      setError(
        err instanceof Error ? err.message : "Could not start subscription"
      );
    } finally {
      setBusy("");
    }
  };

  const confirmSubscribe = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy("save-subscribe");
    setSubscribeMessage("");

    try {
      const stripe = subscribeStripeRef.current;
      const elements = subscribeElementsRef.current;
      if (!stripe || !elements) {
        throw new Error("Payment form is not ready yet");
      }

      // `redirect: "if_required"` keeps the user here when no 3DS challenge is
      // needed. If the bank requires 3DS, Stripe bounces to the bank and back
      // to `return_url`, which is on our own domain, not checkout.stripe.com.
      const result = await stripe.confirmPayment({
        elements,
        confirmParams: {
          return_url: `${window.location.origin}/billing?checkout=success`,
        },
        redirect: "if_required",
      });

      if (result.error) {
        throw new Error(result.error.message ?? "Could not complete payment");
      }

      setSubscribeFormOpen(false);
      setSubscribePlan(null);
      clearSubscribeElements();
      setPaymentSuccess("Subscription started — confirming with Stripe…");
      // Stripe's webhooks flip the local subscriptions row to `active`. Two
      // refresh attempts: the first usually beats the webhook and shows the
      // pending state, the second lands after activation.
      window.setTimeout(() => void refreshAfterUpgrade(), 1500);
      window.setTimeout(() => void refreshAfterUpgrade(), 5000);
    } catch (err) {
      setSubscribeMessage(
        err instanceof Error ? err.message : "Could not complete payment"
      );
    } finally {
      setBusy("");
    }
  };

  // Unmount the Payment Element so it doesn't outlive the React tree.
  useEffect(() => () => clearSubscribeElements(), [clearSubscribeElements]);

  const clearPaymentElements = useCallback(() => {
    paymentElementRef.current?.destroy();
    paymentElementRef.current = null;
    elementsRef.current = null;
    stripeRef.current = null;
    setupClientSecret.current = "";
    setPaymentFormReady(false);
  }, []);

  const openPaymentMethodForm = async () => {
    if (paymentFormOpen) {
      setPaymentFormOpen(false);
      clearPaymentElements();
      return;
    }

    setBusy("payment-method");
    setError("");
    setPaymentMessage("");
    setPaymentSuccess("");
    setPaymentFormOpen(true);
    try {
      const publishableKey = stripeStatus?.publishable_key;
      if (!publishableKey || !publishableKey.startsWith("pk_")) {
        throw new Error("Stripe publishable key is not configured");
      }

      // A SetupIntent client_secret is good for exactly one Elements tree, so
      // cancel + reopen must create a fresh one.
      const [{ client_secret: clientSecret }] = await Promise.all([
        createPaymentMethodSetupIntent(),
        loadStripeScript(),
      ]);
      const stripe = window.Stripe?.(publishableKey) ?? null;
      if (!stripe) throw new Error("Stripe could not initialize");

      const isDark =
        document.documentElement.getAttribute("data-theme") === "dark";
      const elements = stripe.elements({
        clientSecret,
        appearance: { theme: isDark ? "night" : "stripe" },
      });
      const paymentElement = elements.create("payment", {
        layout: "tabs",
        fields: { billingDetails: "auto" },
      });
      paymentElement.on("change", (event) => {
        setPaymentMessage(event.error?.message ?? "");
      });
      paymentElement.on("ready", () => setPaymentFormReady(true));
      paymentElement.mount("#billing-payment-element");

      setupClientSecret.current = clientSecret;
      stripeRef.current = stripe;
      elementsRef.current = elements;
      paymentElementRef.current = paymentElement;
    } catch (err) {
      clearPaymentElements();
      setPaymentFormOpen(false);
      setError(
        err instanceof Error
          ? err.message
          : "Could not prepare payment method form"
      );
    } finally {
      setBusy("");
    }
  };

  const savePaymentMethod = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy("save-payment-method");
    setPaymentMessage("");
    setPaymentSuccess("");

    try {
      const stripe = stripeRef.current;
      const elements = elementsRef.current;
      if (!stripe || !elements) {
        throw new Error("Payment form is not ready yet");
      }

      // On a 3DS card Stripe bounces to return_url, and the effect below reads
      // ?setup_intent_client_secret to finish wiring up the default card.
      const result = await stripe.confirmSetup({
        elements,
        confirmParams: {
          return_url: `${window.location.origin}/billing?pm=saved`,
        },
        redirect: "if_required",
      });

      if (result.error) {
        throw new Error(
          result.error.message ?? "Could not save payment method"
        );
      }

      const paymentMethod = result.setupIntent?.payment_method;
      const paymentMethodId =
        typeof paymentMethod === "string" ? paymentMethod : paymentMethod?.id;
      if (!paymentMethodId) {
        throw new Error("Stripe did not return a payment method");
      }

      await setDefaultPaymentMethod(paymentMethodId);
      setPaymentSuccess("Payment method saved.");
      setPaymentFormOpen(false);
      clearPaymentElements();
      await reload();
    } catch (err) {
      setPaymentMessage(
        err instanceof Error ? err.message : "Could not save payment method"
      );
    } finally {
      setBusy("");
    }
  };

  useEffect(() => () => clearPaymentElements(), [clearPaymentElements]);

  // After a 3DS challenge Stripe returns with ?setup_intent_client_secret.
  // Attach the resulting payment method as default, then strip the query so a
  // refresh doesn't re-trigger this.
  useEffect(() => {
    const intentSecret = params.get("setup_intent_client_secret");
    if (!intentSecret) return;
    const publishableKey = stripeStatus?.publishable_key;
    if (!publishableKey || !publishableKey.startsWith("pk_")) return;

    let cancelled = false;
    void (async () => {
      try {
        await loadStripeScript();
        if (cancelled) return;
        const stripe = window.Stripe?.(publishableKey) ?? null;
        if (!stripe) return;
        const result = await stripe.retrieveSetupIntent(intentSecret);
        if (cancelled) return;
        if (result.error) {
          setError(
            result.error.message ?? "Could not finish saving payment method"
          );
          return;
        }
        const pm = result.setupIntent?.payment_method;
        const pmId = typeof pm === "string" ? pm : pm?.id;
        if (!pmId) return;
        await setDefaultPaymentMethod(pmId);
        if (cancelled) return;
        setPaymentSuccess("Payment method saved.");
        window.history.replaceState({}, "", "/billing");
        await reload();
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof Error
            ? err.message
            : "Could not finish saving payment method"
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [params, stripeStatus, reload]);

  const cancel = async () => {
    setBusy("cancel");
    setError("");
    try {
      await cancelSubscription();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not cancel");
    } finally {
      setBusy("");
    }
  };

  if (loading) {
    return <div className="billing-page">Loading billing…</div>;
  }

  const visiblePlans = [...plans].sort((a, b) => {
    const rankDelta = planDisplayRank(a) - planDisplayRank(b);
    return rankDelta || a.name.localeCompare(b.name);
  });
  const activeSub = sub?.subscription ?? null;
  const canViewStripeDetails =
    user?.account_type === "platform_admin" && user?.effective_role === "owner";

  // Personal plans stay under "Plans"; organization-audience plans render
  // below, split so Business and Enterprise are distinct sections.
  const personalPlans = visiblePlans.filter(
    (plan) => plan.audience === "personal"
  );
  const businessPlans = visiblePlans.filter(
    (plan) => plan.audience === "organization" && plan.tier !== "enterprise"
  );
  const enterprisePlans = visiblePlans.filter(
    (plan) => plan.tier === "enterprise"
  );

  const renderPlanCard = (plan: Plan) => {
    const isCurrent = plan.code === effectiveCurrentCode;
    const isFree = plan.amount_cents === 0;
    const copy = PLAN_COPY[plan.code];
    const isForOwner = plan.audience === ownerType;
    const canBuy = isForOwner && !isCurrent && !isFree;
    const busyHere = busy === `plan:${plan.code}`;
    return (
      <article
        key={plan.id}
        className={`billing-plan ${isCurrent ? "current" : ""}`}
      >
        <h3>{PLAN_TITLE[plan.code] ?? plan.name}</h3>
        <p className="billing-plan-price">
          {copy?.price ??
            (isFree
              ? "Free"
              : `${formatMoney(plan.amount_cents, plan.currency)} / ${plan.billing_interval}`)}
        </p>
        {plan.description && (
          <p className="billing-plan-desc">{plan.description}</p>
        )}
        <ul className="billing-plan-features">
          {(
            copy?.features ?? [
              `${formatBytes(plan.storage_limit_bytes)} storage`,
              `${plan.seat_limit} seat${plan.seat_limit === 1 ? "" : "s"}`,
            ]
          ).map((feature) => (
            <li key={feature}>{feature}</li>
          ))}
        </ul>
        {isCurrent ? (
          <button type="button" disabled>
            Active
          </button>
        ) : canBuy ? (
          <button
            type="button"
            onClick={() => void subscribe(plan)}
            disabled={busyHere}
          >
            {busyHere ? "Preparing…" : hasPaidPlan ? "Switch plan" : "Upgrade"}
          </button>
        ) : !isForOwner &&
          ownerType === "personal" &&
          plan.audience === "organization" ? (
          // Personal accounts can't self-convert into an organization. Business
          // accounts are provisioned separately, so route these to sales.
          <button type="button" onClick={() => navigate("/support")}>
            Contact sales
          </button>
        ) : (
          <button type="button" disabled>
            {isForOwner ? "Free tier" : `Requires ${plan.audience} account`}
          </button>
        )}
      </article>
    );
  };

  return (
    <div className="billing-page">
      <header className="billing-header">
        <div>
          <h1>{hasPaidPlan ? "Billing & Plans" : "Choose a plan"}</h1>
          <p>
            {hasPaidPlan
              ? `${ownerType === "organization" ? "Organization billing" : "Personal billing"} · ${user?.email}`
              : `Pick the plan that fits — you can manage it from this page once subscribed. · ${user?.email}`}
          </p>
        </div>
        {hasPaidPlan && (
          <button
            className="billing-portal-btn"
            onClick={() => void openPaymentMethodForm()}
            disabled={
              busy === "payment-method" || busy === "save-payment-method"
            }
          >
            {busy === "payment-method"
              ? "Preparing…"
              : "Manage payment methods"}
          </button>
        )}
      </header>

      {checkoutStatus === "success" && (
        <div className="billing-banner success">
          Checkout complete — your subscription will update once Stripe
          confirms.
        </div>
      )}
      {checkoutStatus === "cancel" && (
        <div className="billing-banner">Checkout was canceled.</div>
      )}
      {error && <div className="billing-banner error">{error}</div>}
      {paymentSuccess && (
        <div className="billing-banner success">{paymentSuccess}</div>
      )}

      {isOrg && (
        <>
          <section className="billing-card">
            <h2>Monthly billing{org ? ` — ${org.organization.name}` : ""}</h2>
            {activeSub ? (
              <div className="billing-sub">
                <div className="billing-sub-row">
                  <span>Amount</span>
                  <strong className="billing-amount-lg">
                    {formatMoney(activeSub.amount_cents, activeSub.currency)}
                    {activeSub.billing_interval
                      ? ` / ${activeSub.billing_interval}`
                      : " / month"}
                  </strong>
                </div>
                <div className="billing-sub-row">
                  <span>Plan</span>
                  <strong>
                    {activeSub.plan_name ?? activeSub.plan_code ?? "—"}
                  </strong>
                </div>
                <div className="billing-sub-row">
                  <span>Status</span>
                  <strong className={`billing-status ${activeSub.status}`}>
                    {activeSub.status}
                  </strong>
                </div>
                <div className="billing-sub-row">
                  <span>Next charge</span>
                  <strong>{formatDate(activeSub.current_period_end)}</strong>
                </div>
                {activeSub.cancel_at_period_end ? (
                  <p className="billing-note">
                    Cancels at the end of the current period.
                  </p>
                ) : (
                  <button
                    className="billing-cancel-btn"
                    onClick={() => void cancel()}
                    disabled={busy === "cancel"}
                  >
                    {busy === "cancel" ? "Canceling…" : "Cancel subscription"}
                  </button>
                )}
              </div>
            ) : (
              <div className="billing-sub">
                <div className="billing-sub-row">
                  <span>Plan</span>
                  <strong>{planName(org?.plan_code)}</strong>
                </div>
                <div className="billing-sub-row">
                  <span>Status</span>
                  <strong>{org?.plan_active ? "active" : "free"}</strong>
                </div>
                {org && (
                  <div className="billing-sub-row">
                    <span>Seats</span>
                    <strong>
                      {org.seats_used} / {org.seat_limit}
                    </strong>
                  </div>
                )}
                <p className="billing-note">
                  No active paid subscription. Choose a Business or Enterprise
                  plan below to start monthly billing.
                </p>
              </div>
            )}
          </section>

          <section className="billing-card">
            <h2>Billing history</h2>
            {invoices.length > 0 ? (
              <table className="billing-table">
                <thead>
                  <tr>
                    <th>Month</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Receipt</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((invoice) => (
                    <tr key={invoice.id}>
                      <td>{formatMonth(invoice.created_at)}</td>
                      <td>
                        {formatMoney(
                          invoice.amount_paid_cents,
                          invoice.currency
                        )}
                      </td>
                      <td>{invoice.status}</td>
                      <td className="billing-receipt-links">
                        {invoice.invoice_pdf && (
                          <a
                            href={invoice.invoice_pdf}
                            target="_blank"
                            rel="noreferrer"
                            download
                          >
                            Download
                          </a>
                        )}
                        {invoice.hosted_invoice_url && (
                          <a
                            href={invoice.hosted_invoice_url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            View
                          </a>
                        )}
                        {!invoice.invoice_pdf &&
                          !invoice.hosted_invoice_url && (
                            <span className="billing-muted">—</span>
                          )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="billing-empty">
                No bills yet. Monthly receipts will appear here after your first
                charge.
              </p>
            )}
          </section>
        </>
      )}

      {paymentFormOpen && (
        <section className="billing-card">
          <h2>Payment method</h2>
          <form
            className="billing-payment-form"
            onSubmit={(event) => void savePaymentMethod(event)}
          >
            <div
              id="billing-payment-element"
              className="billing-stripe-field"
            />
            {paymentMessage && (
              <p className="billing-payment-error">{paymentMessage}</p>
            )}
            <div className="billing-payment-actions">
              <button
                type="submit"
                disabled={!paymentFormReady || busy === "save-payment-method"}
              >
                {busy === "save-payment-method" ? "Saving…" : "Save card"}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setPaymentFormOpen(false);
                  clearPaymentElements();
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        </section>
      )}

      {subscribeFormOpen && (
        <section className="billing-card" ref={subscribePanelRef}>
          <h2>
            {subscribePlan ? `Upgrade — ${subscribePlan.name}` : "Upgrade"}
          </h2>
          {subscribePlan && (
            <p className="billing-note">
              {formatMoney(subscribePlan.amount_cents, subscribePlan.currency)}
              {subscribePlan.billing_interval
                ? ` / ${subscribePlan.billing_interval}`
                : ""}{" "}
              · charged when you confirm.
            </p>
          )}
          <form
            className="billing-payment-form"
            onSubmit={(event) => void confirmSubscribe(event)}
          >
            {/* Stripe's iframe mounts here; the skeleton sits behind it and is
                covered the moment the Element paints. */}
            <div className="billing-stripe-field billing-stripe-mount">
              {!subscribeFormReady && (
                <div className="billing-stripe-skeleton" aria-hidden="true">
                  <div className="billing-stripe-skeleton-row" />
                  <div className="billing-stripe-skeleton-row" />
                  <div className="billing-stripe-skeleton-row short" />
                </div>
              )}
              <div id="billing-subscribe-element" />
            </div>
            {subscribeMessage && (
              <p className="billing-payment-error">{subscribeMessage}</p>
            )}
            <div className="billing-payment-actions">
              <button
                type="submit"
                disabled={!subscribeFormReady || busy === "save-subscribe"}
              >
                {busy === "save-subscribe"
                  ? "Confirming…"
                  : !subscribeFormReady
                    ? "Loading…"
                    : subscribePlan
                      ? `Pay ${formatMoney(subscribePlan.amount_cents, subscribePlan.currency)}`
                      : "Confirm"}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setSubscribeFormOpen(false);
                  setSubscribePlan(null);
                  clearSubscribeElements();
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        </section>
      )}

      {/* The management sections (Subscription, Usage, Invoices) render only
          for paid users, so a free account sees /billing as a plan picker. */}
      {hasPaidPlan && !isOrg && (
        <section className="billing-card">
          <h2>Subscription</h2>
          {activeSub ? (
            <div className="billing-sub">
              <div className="billing-sub-row">
                <span>Plan</span>
                <strong>
                  {activeSub.plan_name ?? activeSub.plan_code ?? "—"}
                </strong>
              </div>
              <div className="billing-sub-row">
                <span>Status</span>
                <strong className={`billing-status ${activeSub.status}`}>
                  {activeSub.status}
                </strong>
              </div>
              <div className="billing-sub-row">
                <span>Price</span>
                <strong>
                  {formatMoney(activeSub.amount_cents, activeSub.currency)}
                  {activeSub.billing_interval
                    ? ` / ${activeSub.billing_interval}`
                    : ""}
                </strong>
              </div>
              <div className="billing-sub-row">
                <span>Renews</span>
                <strong>{formatDate(activeSub.current_period_end)}</strong>
              </div>
              {activeSub.cancel_at_period_end ? (
                <p className="billing-note">
                  Cancels at the end of the current period.
                </p>
              ) : (
                <button
                  className="billing-cancel-btn"
                  onClick={() => void cancel()}
                  disabled={busy === "cancel"}
                >
                  {busy === "cancel" ? "Canceling…" : "Cancel subscription"}
                </button>
              )}
            </div>
          ) : (
            <p className="billing-empty">
              No active subscription — you are on the free tier.
            </p>
          )}
        </section>
      )}

      {hasPaidPlan && !isOrg && (
        <section className="billing-card">
          <h2>Usage</h2>
          {entitlements && (
            <p className="billing-note">
              Plan limit: {formatBytes(entitlements.storage_limit_bytes)}{" "}
              storage · {entitlements.seat_limit} seats ·{" "}
              {entitlements.active ? "active" : "free tier"}
            </p>
          )}
          {usage && usage.metrics.length > 0 ? (
            <table className="billing-table">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Total</th>
                  <th>Events</th>
                </tr>
              </thead>
              <tbody>
                {usage.metrics.map((metric) => (
                  <tr key={metric.metric}>
                    <td>{metric.metric}</td>
                    <td>{metric.total}</td>
                    <td>{metric.events}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="billing-empty">No usage recorded yet.</p>
          )}
        </section>
      )}

      {/* Plans / checkout, personal accounts only. */}
      {!isOrg && (
        <section className="billing-card">
          <div className="billing-section-head">
            <h2>Plans</h2>
            <label className="billing-autopay">
              <span>AutoPay monthly renewals</span>
              <select
                value={autopay ? "yes" : "no"}
                onChange={(event) => setAutopay(event.target.value === "yes")}
              >
                <option value="yes">YES</option>
                <option value="no">NO</option>
              </select>
            </label>
          </div>
          <div className="billing-plan-grid">
            {personalPlans.map(renderPlanCard)}
            {personalPlans.length === 0 && (
              <p className="billing-empty">No plans available.</p>
            )}
          </div>
        </section>
      )}

      {/* Personal users always see the Business section so they can create an
          org. An org owner only sees it while they have no active
          subscription; once subscribed, the focused view above is all they get. */}
      {businessPlans.length > 0 && (
        <section className="billing-card">
          <div className="billing-section-head">
            <h2>{isOrg && hasPaidPlan ? "Change plan" : "Business"}</h2>
          </div>
          <div className="billing-plan-grid">
            {businessPlans.map(renderPlanCard)}
          </div>
        </section>
      )}

      {enterprisePlans.length > 0 && (
        <section className="billing-card">
          <div className="billing-section-head">
            <h2>Enterprise</h2>
          </div>
          <div className="billing-plan-grid">
            {enterprisePlans.map(renderPlanCard)}
          </div>
        </section>
      )}

      {canViewStripeDetails && (
        <section className="billing-card">
          <h2>Payments</h2>
          <div className="billing-payment-status">
            <span>Stripe status</span>
            <strong
              className={stripeStatus?.configured ? "ready" : "not-ready"}
            >
              {stripeStatus?.configured ? "Connected" : "Not configured"}
            </strong>
            <span>Mode</span>
            <strong>
              {stripeStatus?.test_mode ? "Test mode" : "Live/not detected"}
            </strong>
            <span>Country</span>
            <strong>{stripeStatus?.country ?? "US"}</strong>
            <span>Publishable key</span>
            <code>
              {stripeStatus?.publishable_key ??
                "pk_test_sample_configure_in_env"}
            </code>
          </div>
          <p className="billing-note">
            Enter these test-card numbers in the in-page Payment Element above
            to exercise success / 3DS / decline paths. Test mode only.
          </p>
          <div className="billing-card-list">
            {STRIPE_TEST_CARDS.map((card) => (
              <div className="billing-test-card" key={card.number}>
                <span>{card.label}</span>
                <strong>{card.number}</strong>
                <small>{card.result}</small>
              </div>
            ))}
          </div>
        </section>
      )}

      {hasPaidPlan && !isOrg && (
        <section className="billing-card">
          <h2>Invoices</h2>
          {invoices.length > 0 ? (
            <table className="billing-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((invoice) => (
                  <tr key={invoice.id}>
                    <td>{formatDate(invoice.created_at)}</td>
                    <td>
                      {formatMoney(invoice.amount_paid_cents, invoice.currency)}
                    </td>
                    <td>{invoice.status}</td>
                    <td>
                      {invoice.hosted_invoice_url && (
                        <a
                          href={invoice.hosted_invoice_url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          View
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="billing-empty">No invoices yet.</p>
          )}
        </section>
      )}
    </div>
  );
}

// Access wrapper: an organization member whose role wasn't granted Billing gets
// a "no access" screen. Leaving BillingInner unmounted keeps its many fetches
// (which the backend would 403 anyway) from firing. Personal and platform
// accounts always pass through.
export default function Billing() {
  const { user } = useAuth();
  const isOrg = user?.scope === "organization";
  const [denied, setDenied] = useState(false);
  const [checked, setChecked] = useState(!isOrg);

  const role = user?.effective_role;
  useEffect(() => {
    if (!isOrg) return;
    let cancelled = false;
    void getFeatureAccess()
      .then((d) => {
        if (cancelled) return;
        const b = d.features.find((f) => f.key === "billing");
        const r = role ?? "";
        const allowed = r === "owner" || !b || b.allowed_roles.includes(r);
        setDenied(!allowed);
      })
      .catch(() => {
        /* on error, fail open — the backend still enforces */
      })
      .finally(() => {
        if (!cancelled) setChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [isOrg, role]);

  if (isOrg && !checked) {
    return <div className="billing-page billing-loading">Loading…</div>;
  }
  if (denied) {
    return (
      <div className="billing-page">
        <div className="billing-card">
          <h2>Billing</h2>
          <p className="billing-empty">
            Your role doesn’t have access to Billing. Ask an organization owner
            if you need it.
          </p>
        </div>
      </div>
    );
  }
  return <BillingInner />;
}
