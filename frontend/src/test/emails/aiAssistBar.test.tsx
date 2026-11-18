// The AI row under the email editors: it rewrites what was typed, drafts a
// reply from the email being read, can be undone, and stays out of the way
// when there is nothing to work on or AI must not be used.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

vi.mock("../../api/emailAssist", () => ({ emailAssist: vi.fn() }));

import AiAssistBar from "../../emails/AiAssistBar";
import { emailAssist } from "../../api/emailAssist";

const mockAssist = emailAssist as unknown as ReturnType<typeof vi.fn>;

const ORIGINAL = {
  from: "Asha <asha@example.com>",
  subject: "Lunch?",
  body: "Are you free Friday?",
};

// An editor around the bar, the way the compose and reply windows hold it.
function Editor({
  initial = "",
  original,
  offReason,
}: {
  initial?: string;
  original?: typeof ORIGINAL;
  offReason?: string;
}) {
  const [text, setText] = useState(initial);
  return (
    <>
      <textarea
        aria-label="Body"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <AiAssistBar
        text={text}
        onApply={setText}
        original={original}
        offReason={offReason}
      />
    </>
  );
}

const body = () => screen.getByLabelText("Body") as HTMLTextAreaElement;

describe("AiAssistBar", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("rewrites the typed text and can undo it", async () => {
    mockAssist.mockResolvedValue({ text: "I have gone." });
    render(<Editor initial="i has went" />);

    await userEvent.click(screen.getByRole("button", { name: "Fix grammar" }));

    await waitFor(() => expect(body().value).toBe("I have gone."));
    expect(mockAssist).toHaveBeenCalledWith({
      action: "fix_grammar",
      text: "i has went",
    });

    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(body().value).toBe("i has went");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("has nothing to rewrite until something is typed", () => {
    render(<Editor />);

    for (const name of ["Fix grammar", "Improve", "Shorter", "More formal"]) {
      expect(
        (screen.getByRole("button", { name }) as HTMLButtonElement).disabled
      ).toBe(true);
    }
    // Compose has no email to answer.
    expect(screen.queryByRole("button", { name: "Write a reply" })).toBeNull();
  });

  it("drafts a reply from the email, with what was typed as its notes", async () => {
    mockAssist.mockResolvedValue({ text: "Friday at 1pm works for me." });
    render(<Editor initial="yes 1pm" original={ORIGINAL} />);

    await userEvent.click(
      screen.getByRole("button", { name: "Write a reply" })
    );

    await waitFor(() =>
      expect(body().value).toBe("Friday at 1pm works for me.")
    );
    expect(mockAssist).toHaveBeenCalledWith({
      action: "reply",
      text: "yes 1pm",
      // The sender's name goes to the AI; their address stays here.
      original: { ...ORIGINAL, from: "Asha" },
    });
  });

  it("waits for the email to load before offering a reply", () => {
    render(<Editor original={{ ...ORIGINAL, body: "" }} />);

    expect(
      (
        screen.getByRole("button", {
          name: "Write a reply",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
  });

  it("shows why it failed and leaves the text alone", async () => {
    mockAssist.mockRejectedValue(
      new Error("AI access to email is switched off in Settings › AI")
    );
    render(<Editor initial="draft" original={ORIGINAL} />);

    await userEvent.click(
      screen.getByRole("button", { name: "Write a reply" })
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "switched off"
    );
    expect(body().value).toBe("draft");
  });

  it("drops the answer if the writer kept typing", async () => {
    let finish: (v: { text: string }) => void = () => {};
    mockAssist.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    render(<Editor initial="hello" />);

    await userEvent.click(screen.getByRole("button", { name: "Improve" }));
    await userEvent.type(body(), " there");
    finish({ text: "Greetings." });

    expect((await screen.findByRole("alert")).textContent).toContain(
      "kept typing"
    );
    expect(body().value).toBe("hello there");
  });

  it("is switched off, with the reason, for an encrypted send", () => {
    render(<Editor initial="secret" offReason="Off for encrypted sends." />);

    expect(screen.getByText("Off for encrypted sends.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
