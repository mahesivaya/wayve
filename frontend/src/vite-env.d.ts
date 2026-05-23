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
  on: (event: "change", handler: (event: StripeElementChangeEvent) => void) => void;
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
  create(type: "payment", options?: Record<string, unknown>): StripePaymentElement;
};

type StripeSetupIntentResult = {
  error?: { message?: string };
  setupIntent?: {
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
  retrieveSetupIntent: (clientSecret: string) => Promise<StripeSetupIntentResult>;
};

interface Window {
  Stripe?: (publishableKey: string) => StripeInstance | null;
}
