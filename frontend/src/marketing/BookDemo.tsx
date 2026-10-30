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
  // The preferred slot, picked as a date plus 12-hour HH, MM and AM/PM selects
  // and joined into the API's 24-hour YYYY-MM-DDTHH:mm (no seconds) by
  // `slotOf`.
  date: string; // YYYY-MM-DD
  hour: string; // "01"–"12"
  minute: string; // "00"–"55", 5-minute steps
  period: "" | "AM" | "PM";
};

const EMPTY: DemoForm = {
  firstName: "",
  lastName: "",
  email: "",
  workEmail: "",
  date: "",
  hour: "",
  minute: "",
  period: "",
};

const pad2 = (n: number) => String(n).padStart(2, "0");
const HOURS = Array.from({ length: 12 }, (_, i) => pad2(i + 1));
const MINUTES = Array.from({ length: 12 }, (_, i) => pad2(i * 5));

// "" until every part is picked. 12 AM is 00, 12 PM is 12.
const slotOf = (f: DemoForm) => {
  if (!f.date || !f.hour || !f.minute || !f.period) return "";
  const hour24 = (Number(f.hour) % 12) + (f.period === "PM" ? 12 : 0);
  return `${f.date}T${pad2(hour24)}:${f.minute}`;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function BookDemo() {
  const navigate = useNavigate();
  const [form, setForm] = useState<DemoForm>(EMPTY);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<
    | (Omit<DemoForm, "date" | "hour" | "minute" | "period"> & {
        slot: string;
      })
    | null
  >(null);

  // The earliest bookable slot is "now" in the visitor's local time, as
  // YYYY-MM-DDTHH:mm (no seconds, no zone); the date picker starts at its day.
  const minSlot = useMemo(() => {
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    return now.toISOString().slice(0, 16);
  }, []);

  const set =
    (key: keyof DemoForm) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>): void =>
      setForm((prev) => ({ ...prev, [key]: e.target.value }));

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");

    const firstName = form.firstName.trim();
    const lastName = form.lastName.trim();
    const email = form.email.trim();
    const workEmail = form.workEmail.trim();

    const slot = slotOf(form);
    if (!firstName || !lastName || !email || !workEmail || !slot) {
      setError("Please fill in every field, including a date and time.");
      return;
    }
    // Same-length YYYY-MM-DDTHH:mm strings compare chronologically.
    if (slot < minSlot) {
      setError("Please pick a date and time in the future.");
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
        slot,
      });
      setSubmitted({ firstName, lastName, email, workEmail, slot });
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
    <MarketingShell themeable>
      <section className="book-demo">
        <div className="book-demo-intro">
          <p className="marketing-eyebrow">Book a demo</p>
          <h1>See Fluxze in action.</h1>
          <p className="lead">
            Tell us a little about you and pick a time that works. We'll walk
            you through mail, chat, calls, files, and AI in one private
            workspace.
          </p>
        </div>

        {submitted ? (
          <div className="book-demo-success" role="status">
            <span className="book-demo-success-icon" aria-hidden="true">
              ✅
            </span>
            <h2>You're booked, {submitted.firstName}!</h2>
            <p>
              We've noted your demo for{" "}
              <strong>{prettySlot(submitted.slot)}</strong>. A confirmation will
              go to <strong>{submitted.workEmail}</strong>.
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
                autoComplete="email"
                required
              />
            </label>

            <fieldset className="book-demo-field book-demo-slot">
              <legend className="book-demo-label">
                Preferred date &amp; time
              </legend>
              <div className="book-demo-slot-row">
                <input
                  type="date"
                  className="book-demo-input"
                  aria-label="Date"
                  value={form.date}
                  min={minSlot.slice(0, 10)}
                  onChange={set("date")}
                  required
                />
                <select
                  className="book-demo-input book-demo-time"
                  aria-label="Hour"
                  value={form.hour}
                  onChange={set("hour")}
                  required
                >
                  <option value="" disabled>
                    HH
                  </option>
                  {HOURS.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
                <span className="book-demo-time-sep" aria-hidden="true">
                  :
                </span>
                <select
                  className="book-demo-input book-demo-time"
                  aria-label="Minute"
                  value={form.minute}
                  onChange={set("minute")}
                  required
                >
                  <option value="" disabled>
                    MM
                  </option>
                  {MINUTES.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                <select
                  className="book-demo-input book-demo-time book-demo-period"
                  aria-label="AM or PM"
                  value={form.period}
                  onChange={set("period")}
                  required
                >
                  <option value="" disabled>
                    AM/PM
                  </option>
                  <option value="AM">AM</option>
                  <option value="PM">PM</option>
                </select>
              </div>
            </fieldset>

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
