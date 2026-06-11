import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/useAuth";
import { invalidateGetCache } from "../api/client";
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
import { fmtShortDate } from "../utils/datetime";
import "./billing.css";

const BYTES_IN_GB = 1024 * 1024 * 1024;
const UNLIMITED_STORAGE = -1;

const PLAN_COPY: Record<
  string,
  { price: string; features: string[]; action?: string }
> = {
  basic_user: {
    price: "Free",
    features: [
      "1 GB encrypted storage",
      "Up to 1,000 emails per day",
      "End-to-end encrypted chat",
      "1 seat",
    ],
  },
  advance_user: {
    price: "$7 / month",
    features: [
      "10 GB encrypted storage",
      "Unlimited daily emails",
      "1,000 encrypt/decrypt ops per day",
      "Priority email sync",
    ],
  },
  most_advance_user: {
    price: "$15 / month",
    features: [
      "50 GB encrypted storage",
      "Unlimited email & calls",
      "Full AI assistant access",
      "Priority support",
    ],
  },
  business_startups: {
    price: "$8 / user / month",
    features: [
      "Up to 20 members",
      "Unlimited shared storage",
      "Shared org workspace",
      "Admin & billing controls",
    ],
  },
  organization: {
    price: "$12 / user / month",
    features: [
      "Up to 100 members",
      "Unlimited storage & email",
      "SSO + role-based access",
      "Audit logs & priority support",
    ],
  },
  enterprise: {
    price: "Contact sales",
    features: [
      "Unlimited members",
      "Dedicated success manager",
      "Custom onboarding & SLA",
      "SSO, SCIM & advanced security",
    ],
    action: "Contact sales",
  },
};

const PLAN_DISPLAY_ORDER = [
  "basic_user",
  "advance_user",
  "most_advance_user",
  "business_startups",
  "organization",
  "enterprise",
];

// Plan titles come straight from the DB `name` column now (Basic / Advance /
// Most Advance / Startups / Business / Enterprise), so no per-code override is
// needed. Kept as an empty escape hatch for future display-only renames.
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

// "June 2026" — the billing history is one row per month, so we label each
// charge by its month rather than the exact day.
function formatMonth(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fmtShortDate(value);
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

// Reference samples shown on an organization's billing page before any real
// Stripe invoices exist, so the layout (monthly amount, history, downloadable
// receipts) is demonstrable. Negative ids keep them clear of real rows; the
// receipt links are placeholders. Replaced by live data once invoices land.
const SAMPLE_MONTHLY_AMOUNT_CENTS = 9000; // 9 seats × $10/user/month
const SAMPLE_INVOICES: Invoice[] = [
  {
    id: -1,
    stripe_invoice_id: "sample_in_0003",
    amount_due_cents: 9000,
    amount_paid_cents: 9000,
    currency: "usd",
    status: "paid",
    hosted_invoice_url: "#",
    invoice_pdf: "#",
    created_at: "2026-05-01T00:00:00Z",
  },
  {
    id: -2,
    stripe_invoice_id: "sample_in_0002",
    amount_due_cents: 8000,
    amount_paid_cents: 8000,
    currency: "usd",
    status: "paid",
    hosted_invoice_url: "#",
    invoice_pdf: "#",
    created_at: "2026-04-01T00:00:00Z",
  },
  {
    id: -3,
    stripe_invoice_id: "sample_in_0001",
    amount_due_cents: 8000,
    amount_paid_cents: 8000,
    currency: "usd",
    status: "paid",
    hosted_invoice_url: "#",
    invoice_pdf: "#",
    created_at: "2026-03-01T00:00:00Z",
  },
];

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

export default function Billing() {
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

  // Inline-subscription Payment Element. Parallel to the payment-method
  // form above — they use distinct Stripe Element trees because one
  // confirms a SetupIntent (saving a card) and the other confirms a
  // PaymentIntent (charging the first invoice), and Elements doesn't
  // let you swap intent types on an existing mount.
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
  // Cached Stripe.js instance — initialized once when the page mounts so
  // clicking Subscribe doesn't pay the script-download + init cost on
  // every click. ~200-500ms saved on the first subscribe attempt.
  const preloadedStripeRef = useRef<StripeInstance | null>(null);
  // The DOM node we scroll into view when the subscribe panel opens, so
  // the user can see the form appear inline rather than feeling like
  // the page jumped to a new screen.
  const subscribePanelRef = useRef<HTMLElement | null>(null);

  const checkoutStatus = params.get("checkout");

  const reload = useCallback(async () => {
    setError("");
    try {
      const [planList, subscription, ent, invoiceList, usageData, stripe] =
        await Promise.all([
          listPlans(),
          getSubscription(),
          getEntitlements(),
          listInvoices(),
          getUsage(),
          getStripeStatus(),
        ]);
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
      void reload();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [reload]);

  // After an upgrade, the plan/limit/status live in several caches: the
  // frontend GET cache (/api/profile, /api/accounts), the global auth user
  // (`current_plan`, drives the whole app + Settings), and this page's billing
  // data. Clear the GET cache and refetch all three so every surface — Settings
  // storage limit, plan badge, the storage banner — reflects the new plan
  // immediately. Stripe's activation webhook is async, so callers schedule a
  // couple of attempts to catch it.
  const refreshAfterUpgrade = useCallback(async () => {
    invalidateGetCache();
    await Promise.allSettled([reload(), refresh()]);
  }, [reload, refresh]);

  // Warm-up: download Stripe.js + init `Stripe(publishableKey)` as soon
  // as we know the key. By the time the user clicks Subscribe, the only
  // remaining latency is the backend → Stripe round-trip plus Stripe's
  // own iframe handshake; the ~200-500ms script download is already gone.
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
        // Best-effort: subscribe() will retry the load on click if this
        // failed (e.g. user is offline at page-load time).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [stripeStatus]);

  const ownerType = sub?.owner_type ?? "personal";

  // Post-checkout redirect: after a successful Stripe checkout that
  // belongs to an organization, send the owner to /organization-home so
  // they land on their workspace dashboard instead of staying on the
  // billing screen. Personal-plan checkouts stay on /billing where the
  // user just landed from Stripe (existing behavior). The brief delay
  // lets the success banner flash before navigation so the user has
  // visual confirmation of the charge.
  useEffect(() => {
    if (loading) return;
    if (checkoutStatus !== "success") return;
    if (ownerType !== "organization") return;
    const handle = window.setTimeout(() => {
      navigate("/organization/home", { replace: true });
    }, 1500);
    return () => window.clearTimeout(handle);
  }, [loading, checkoutStatus, ownerType, navigate]);

  // Returning from a successful checkout (hosted or inline redirect): refresh
  // plan-derived data everywhere. Retry once after a few seconds since Stripe's
  // activation webhook may not have landed when we first re-fetch.
  useEffect(() => {
    if (checkoutStatus !== "success") return;
    void refreshAfterUpgrade();
    const retry = window.setTimeout(() => void refreshAfterUpgrade(), 4000);
    return () => window.clearTimeout(retry);
  }, [checkoutStatus, refreshAfterUpgrade]);

  const currentPlanCode = sub?.subscription?.plan_code ?? null;
  // A personal account with no subscription row is implicitly on the free
  // Basic tier — surface that explicitly so the card renders as "Active"
  // instead of falling through to the generic "Included" placeholder.
  const effectiveCurrentCode =
    currentPlanCode ?? (ownerType === "personal" ? "basic_user" : null);
  const hasPaidPlan = (sub?.subscription?.amount_cents ?? 0) > 0;
  // Organization owners get a focused billing view (monthly amount, monthly
  // bill history, downloadable receipts) instead of the personal
  // plan-selection + usage + members layout.
  const isOrg = ownerType === "organization";

  const clearSubscribeElements = useCallback(() => {
    subscribePaymentElementRef.current?.destroy();
    subscribePaymentElementRef.current = null;
    subscribeElementsRef.current = null;
    subscribeStripeRef.current = null;
    subscribeClientSecret.current = "";
    setSubscribeFormReady(false);
  }, []);

  // Open the in-page subscribe form for `plan`. Creates the subscription
  // server-side in `incomplete` state and mounts a Payment Element bound
  // to the latest invoice's PaymentIntent. Confirmation happens locally
  // via stripe.confirmPayment — no redirect to checkout.stripe.com.
  const subscribe = async (plan: Plan) => {
    setBusy(`plan:${plan.code}`);
    setError("");
    setSubscribeMessage("");
    setPaymentSuccess("");
    // Mutually exclusive with the payment-method form so two Element
    // trees don't compete for focus / a stale clientSecret.
    if (paymentFormOpen) {
      setPaymentFormOpen(false);
      clearPaymentElements();
    }
    setSubscribePlan(plan);
    setSubscribeFormOpen(true);
    // Scroll the new panel into view on the next frame (after React
    // commits the show-panel render), so the user sees the form expand
    // inline instead of perceiving a navigation away from the Plans
    // section they just clicked from.
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

      // Use the preloaded Stripe instance when available — it's already
      // downloaded + initialized from the mount-time warm-up effect.
      // Fall back to a fresh load if the preload hasn't finished yet or
      // failed (offline at mount, slow script CDN, etc.).
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

      // `redirect: "if_required"` keeps the user on this page when no
      // 3DS challenge is needed. When the bank DOES require 3DS, Stripe
      // bounces to the bank's auth page and then back to `return_url`
      // — that URL is on our own domain, NOT checkout.stripe.com.
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

      // PaymentIntent succeeded inline (no redirect). Stripe will fire
      // `invoice.payment_succeeded` + `customer.subscription.updated`
      // webhooks that flip our local subscriptions row to `active`. The
      // delay gives those a fighting chance to land before we re-fetch;
      // worst case the user sees `incomplete` briefly and the next
      // refresh corrects it.
      setSubscribeFormOpen(false);
      setSubscribePlan(null);
      clearSubscribeElements();
      setPaymentSuccess("Subscription started — confirming with Stripe…");
      // Two attempts: the first usually beats the webhook (shows the pending
      // state), the second lands after activation so plan/limit/status settle
      // across Settings, the plan badge, and the storage banner.
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

  // Unmount the Payment Element on Billing's unmount so it doesn't
  // outlive the React tree.
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

      // SetupIntent's client_secret must be created once per Elements tree.
      // Cancel + reopen creates a fresh one (clearPaymentElements resets it).
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

      // redirect: "if_required" keeps us on the page when no 3DS challenge is
      // needed; on a 3DS card Stripe bounces to return_url and the effect
      // below reads ?setup_intent_client_secret to finish wiring the default.
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

  // Post-return handler: after a 3DS challenge Stripe bounces back to
  // return_url with ?setup_intent_client_secret in the URL. Retrieve the
  // intent, attach the resulting payment method as default, then strip the
  // query so refreshes don't re-trigger.
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

  // Personal plans stay under "Plans"; business/enterprise (audience
  // "organization") render in their own section below.
  const personalPlans = visiblePlans.filter(
    (plan) => plan.audience === "personal"
  );
  const businessPlans = visiblePlans.filter(
    (plan) => plan.audience === "organization"
  );

  const renderPlanCard = (plan: Plan) => {
    const isCurrent = plan.code === effectiveCurrentCode;
    const isFree = plan.amount_cents === 0;
    const copy = PLAN_COPY[plan.code];
    const isEnterprise = plan.code === "enterprise";
    const isForOwner = plan.audience === ownerType;
    const canBuy = isForOwner && !isCurrent && !isFree && !isEnterprise;
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
        ) : isEnterprise ? (
          <button type="button" onClick={() => navigate("/support")}>
            Contact sales
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
          // Self-serve upgrade from a personal account to a business
          // (organization) account is currently disabled. Org plans are
          // provisioned through sales / support instead.
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

      {/* ---- Organization billing (focused view) ---- */}
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
                  <span>Amount</span>
                  <strong className="billing-amount-lg">
                    {formatMoney(SAMPLE_MONTHLY_AMOUNT_CENTS, "usd")} / month
                  </strong>
                </div>
                <div className="billing-sub-row">
                  <span>Plan</span>
                  <strong>Business</strong>
                </div>
                <p className="billing-note billing-sample-note">
                  Sample figures for reference — no active subscription yet.
                  Choose a Business or Enterprise plan to start monthly billing.
                </p>
              </div>
            )}
          </section>

          <section className="billing-card">
            <h2>Billing history</h2>
            {invoices.length === 0 && (
              <p className="billing-note billing-sample-note">
                Sample bills shown for reference. Your real monthly receipts
                will appear here after the first charge.
              </p>
            )}
            {(invoices.length > 0 ? invoices : SAMPLE_INVOICES).length > 0 ? (
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
                  {(invoices.length > 0 ? invoices : SAMPLE_INVOICES).map(
                    (invoice) => (
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
                    )
                  )}
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
            {/* Stripe's iframe mounts here. While it's still loading
                (backend round-trip + iframe handshake, ~1-2s) show a
                skeleton so the panel doesn't look broken. The skeleton
                is purely cosmetic — it sits behind the Element and is
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

      {/* ---- Subscription status ---- */}
      {/* Management-only sections (Subscription, Usage, Invoices) render
          only for paid users — a brand-new free account has nothing to
          manage, so /billing collapses to a plan picker. The page reveals
          the full management surface automatically after the first
          successful checkout. */}
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

      {/* ---- Usage ---- */}
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

      {/* ---- Plans / Checkout (personal accounts only) ---- */}
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

      {/* ---- Business & Enterprise ---- */}
      {/* Personal users always see this (to create an org); an org owner only
          sees it while they have no active subscription, so they can subscribe.
          Once subscribed, the focused billing view above is all they get. */}
      {businessPlans.length > 0 && (!isOrg || !hasPaidPlan) && (
        <section className="billing-card">
          <div className="billing-section-head">
            <h2>Business &amp; Enterprise</h2>
          </div>
          <div className="billing-plan-grid">
            {businessPlans.map(renderPlanCard)}
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

      {/* ---- Invoices ---- */}
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
