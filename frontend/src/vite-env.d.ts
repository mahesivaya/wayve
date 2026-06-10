/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/* 🔥 FIX CSS IMPORT ERRORS */
declare module "*.css";

type StripeElementChangeEvent = {
  error?: { message?: string };
};

type StripeCardElement = {
  mount: (selector: string) => void;
  destroy: () => void;
  on: (
    event: "change",
    handler: (event: StripeElementChangeEvent) => void
  ) => void;
};

type StripePaymentElement = {
  mount: (selector: string) => void;
  destroy: () => void;
  on: (
    event: "ready" | "change" | "blur" | "focus" | "loaderror",
    handler: (event: StripeElementChangeEvent) => void
  ) => void;
};

type StripeElements = {
  create(
    type: "cardNumber" | "cardExpiry" | "cardCvc",
    options?: Record<string, unknown>
  ): StripeCardElement;
  create(
    type: "payment",
    options?: Record<string, unknown>
  ): StripePaymentElement;
};

type StripeSetupIntentResult = {
  error?: { message?: string };
  setupIntent?: {
    status?: string;
    payment_method?: string | { id?: string };
  };
};

type StripePaymentIntentResult = {
  error?: { message?: string };
  paymentIntent?: {
    status?: string;
    payment_method?: string | { id?: string };
  };
};

type StripeInstance = {
  elements: (options?: Record<string, unknown>) => StripeElements;
  confirmCardSetup: (
    clientSecret: string,
    data: {
      payment_method: {
        card: StripeCardElement;
        billing_details?: {
          address?: {
            postal_code?: string;
          };
        };
      };
    }
  ) => Promise<StripeSetupIntentResult>;
  confirmSetup: (params: {
    elements: StripeElements;
    confirmParams?: { return_url?: string };
    redirect?: "always" | "if_required";
  }) => Promise<StripeSetupIntentResult>;
  // Confirms a PaymentIntent that's already linked to a Payment Element
  // tree. Used by the inline-subscription flow — Stripe charges the
  // first invoice and resolves the Promise without ever leaving our
  // page (except for the rare bank-issued 3DS redirect, which bounces
  // back to confirmParams.return_url on our own domain).
  confirmPayment: (params: {
    elements: StripeElements;
    confirmParams?: { return_url?: string };
    redirect?: "always" | "if_required";
  }) => Promise<StripePaymentIntentResult>;
  retrieveSetupIntent: (
    clientSecret: string
  ) => Promise<StripeSetupIntentResult>;
};

interface Window {
  Stripe?: (publishableKey: string) => StripeInstance | null;
}
