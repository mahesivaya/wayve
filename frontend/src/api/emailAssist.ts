import { apiFetchJson } from "./client";

// AI help in the email compose and reply windows. The four rewrites work on
// the text the user typed; "reply" drafts an answer to the email they are
// replying to, taking anything already typed as what the reply should say.
export type EmailAssistAction =
  "fix_grammar" | "improve" | "shorter" | "formal" | "reply";

// The email being answered, as the browser shows it. It is sent along because
// mailbox bodies are sealed to their owner's key: the server has no readable
// copy to look up.
export type EmailAssistOriginal = {
  from: string;
  subject: string;
  body: string;
};

export type EmailAssistRequest = {
  action: EmailAssistAction;
  text: string;
  original?: EmailAssistOriginal;
};

export type EmailAssistResponse = {
  text: string;
  provider?: string | null;
  model?: string | null;
};

export const emailAssist = async (request: EmailAssistRequest) =>
  apiFetchJson<EmailAssistResponse>("/api/ai/email-assist", {
    method: "POST",
    body: JSON.stringify(request),
  });
