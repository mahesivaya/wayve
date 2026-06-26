import { FormEvent, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import MarketingShell from "./MarketingShell";
import { submitDemoRequest } from "../api/demo";
import "./bookDemo.css";

type DemoForm = {
  firstName: string;
  lastName: string;
  email: string;
  workEmail: string;
  slot: string; // datetime-local value (YYYY-MM-DDTHH:mm)
};

const EMPTY: DemoForm = {
  firstName: "",
  lastName: "",
  email: "",
  workEmail: "",
  slot: "",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function BookDemo() {
  const navigate = useNavigate();
  const [form, setForm] = useState<DemoForm>(EMPTY);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<DemoForm | null>(null);

  // The earliest selectable slot is "now" in the visitor's local time,
  // formatted for <input type="datetime-local"> (no seconds, no zone).
  const minSlot = useMemo(() => {
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    return now.toISOString().slice(0, 16);
  }, []);

  const set =
    (key: keyof DemoForm) =>
    (e: React.ChangeEvent<HTMLInputElement>): void =>
      setForm((prev) => ({ ...prev, [key]: e.target.value }));

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");

    const firstName = form.firstName.trim();
    const lastName = form.lastName.trim();
    const email = form.email.trim();
    const workEmail = form.workEmail.trim();

    if (!firstName || !lastName || !email || !workEmail || !form.slot) {
      setError("Please fill in every field, including a date and time.");
      return;
    }
    if (!EMAIL_RE.test(email) || !EMAIL_RE.test(workEmail)) {
      setError("Please enter valid email addresses.");
      return;
    }

    setSubmitting(true);
    try {
      // Persists the lead, emails sales, and sends an .ics calendar invite.
      await submitDemoRequest({
        firstName,
        lastName,
        email,
        workEmail,
        slot: form.slot,
      });
      setSubmitted({ firstName, lastName, email, workEmail, slot: form.slot });
      setForm(EMPTY);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not submit your request."
      );
    } finally {
      setSubmitting(false);
    }
  };

  const prettySlot = (value: string) =>
    new Date(value).toLocaleString(undefined, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });

  return (
    <MarketingShell>
      <section className="book-demo">
        <div className="book-demo-intro">
          <p className="marketing-eyebrow">Book a demo</p>
          <h1>See Fluxze in action.</h1>
          <p className="lead">
            Tell us a little about you and pick a time that works. We'll walk you
            through mail, chat, calls, files, and AI in one private workspace.
          </p>
        </div>

        {submitted ? (
          <div className="book-demo-success" role="status">
            <span className="book-demo-success-icon" aria-hidden="true">
              ✅
            </span>
            <h2>You're booked, {submitted.firstName}!</h2>
            <p>
              We've noted your demo for <strong>{prettySlot(submitted.slot)}</strong>.
              A confirmation will go to <strong>{submitted.workEmail}</strong>.
            </p>
            <div className="book-demo-success-actions">
              <button
                type="button"
                className="book-demo-submit"
                onClick={() => setSubmitted(null)}
              >
                Book another time
              </button>
              <button
                type="button"
                className="book-demo-secondary"
                onClick={() => navigate("/")}
              >
                Back to home
              </button>
            </div>
          </div>
        ) : (
          <form className="book-demo-card" onSubmit={handleSubmit} noValidate>
            <div className="book-demo-row">
              <label className="book-demo-field">
                <span className="book-demo-label">First name</span>
                <input
                  className="book-demo-input"
                  value={form.firstName}
                  onChange={set("firstName")}
                  placeholder="Ada"
                  autoComplete="given-name"
                  required
                />
              </label>
              <label className="book-demo-field">
                <span className="book-demo-label">Last name</span>
                <input
                  className="book-demo-input"
                  value={form.lastName}
                  onChange={set("lastName")}
                  placeholder="Lovelace"
                  autoComplete="family-name"
                  required
                />
              </label>
            </div>

            <label className="book-demo-field">
              <span className="book-demo-label">Email address</span>
              <input
                type="email"
                className="book-demo-input"
                value={form.email}
                onChange={set("email")}
                placeholder="ada@example.com"
                autoComplete="email"
                required
              />
            </label>

            <label className="book-demo-field">
              <span className="book-demo-label">Work email</span>
              <input
                type="email"
                className="book-demo-input"
                value={form.workEmail}
                onChange={set("workEmail")}
                placeholder="ada@company.com"
                autoComplete="email"
                required
              />
            </label>

            <label className="book-demo-field">
              <span className="book-demo-label">Preferred date &amp; time</span>
              <input
                type="datetime-local"
                className="book-demo-input"
                value={form.slot}
                min={minSlot}
                onChange={set("slot")}
                required
              />
            </label>

            {error && <p className="book-demo-error">{error}</p>}

            <button
              type="submit"
              className="book-demo-submit"
              disabled={submitting}
            >
              {submitting ? "Submitting…" : "Submit"}
            </button>
          </form>
        )}
      </section>
    </MarketingShell>
  );
}
