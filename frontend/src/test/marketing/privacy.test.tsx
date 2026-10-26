// The public privacy policy. Google's OAuth verification checks that it carries
// the Google API Services User Data Policy "Limited Use" statement and links to
// that policy, and that it discloses every scope the Gmail connect requests.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({ user: null, logout: vi.fn() }),
}));

import Privacy from "../../marketing/Privacy";

const renderPrivacy = () =>
  render(
    <MemoryRouter initialEntries={["/privacy"]}>
      <Privacy />
    </MemoryRouter>
  );

describe("Privacy policy page", () => {
  it("carries the Limited Use statement and links to the User Data Policy", () => {
    const { container } = renderPrivacy();
    expect(container.textContent).toContain(
      "use and transfer to any other app of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements."
    );
    const link = screen.getByRole("link", {
      name: "Google API Services User Data Policy",
    });
    expect(link.getAttribute("href")).toBe(
      "https://developers.google.com/terms/api-services-user-data-policy"
    );
  });

  it("discloses every Google scope the Gmail connect requests", () => {
    const { container } = renderPrivacy();
    for (const scope of [
      "userinfo.email",
      "gmail.readonly",
      "gmail.modify",
      "gmail.send",
      "calendar.readonly",
      "contacts.readonly",
      "contacts.other.readonly",
    ]) {
      expect(container.textContent).toContain(scope);
    }
  });

  it("states that Google data is not used to train AI models", () => {
    const { container } = renderPrivacy();
    expect(container.textContent).toContain(
      "to develop, improve or train generalized artificial intelligence or machine learning models"
    );
  });
});
