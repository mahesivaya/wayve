// The Pause AI switches: an organization's owner pauses the whole organization
// or a single member, and the platform owner pauses any organization.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../../api/aiProvider", () => ({
  getAiPause: vi.fn(),
  setAiOrgPaused: vi.fn().mockResolvedValue({ paused: true }),
  setAiMemberPaused: vi.fn().mockResolvedValue({ paused: true }),
  setAiOrganizationPausedByPlatform: vi
    .fn()
    .mockResolvedValue({ paused: true }),
}));

import AiPausePanel from "../../settings/AiPausePanel";
import {
  getAiPause,
  setAiMemberPaused,
  setAiOrgPaused,
  setAiOrganizationPausedByPlatform,
} from "../../api/aiProvider";

const mockPause = getAiPause as unknown as ReturnType<typeof vi.fn>;

const orgState = {
  scope: "organization" as const,
  paused: false,
  paused_by_platform: false,
  members: [
    { user_id: 11, name: "Asha Rao", username: "asha", paused: false },
    { user_id: 12, name: "Bo Lee", username: "bo", paused: true },
  ],
};

const platformState = {
  scope: "platform" as const,
  limit: 50,
  organizations: [
    { id: 3, name: "Acme", members: 12, paused: false, paused_by_owner: false },
    { id: 4, name: "Globex", members: 5, paused: true, paused_by_owner: false },
    {
      id: 5,
      name: "Initech",
      members: 2,
      paused: false,
      paused_by_owner: true,
    },
  ],
};

describe("AiPausePanel", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("lets an organization's owner pause one member", async () => {
    mockPause.mockResolvedValue(orgState);
    render(<AiPausePanel />);

    const asha = (await screen.findByText("asha")).closest("tr") as HTMLElement;
    expect(asha.textContent).toContain("Active");
    // A member already paused is offered Resume.
    expect(
      screen.getByRole("button", { name: "Resume AI for bo" })
    ).toBeTruthy();

    mockPause.mockResolvedValue({
      ...orgState,
      members: [{ ...orgState.members[0], paused: true }, orgState.members[1]],
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Pause AI for asha" })
    );

    expect(setAiMemberPaused).toHaveBeenCalledWith(11, true);
    expect(
      await screen.findByRole("button", { name: "Resume AI for asha" })
    ).toBeTruthy();
  });

  it("lets an organization's owner pause and resume everyone", async () => {
    mockPause.mockResolvedValue(orgState);
    render(<AiPausePanel />);

    await userEvent.click(
      await screen.findByRole("button", {
        name: "Pause AI for the whole organization",
      })
    );
    expect(setAiOrgPaused).toHaveBeenCalledWith(true);
  });

  it("tells the owner when the platform has paused the organization", async () => {
    mockPause.mockResolvedValue({ ...orgState, paused_by_platform: true });
    render(<AiPausePanel />);

    expect(
      await screen.findByText(
        /The platform has paused AI for this organization/
      )
    ).toBeTruthy();
  });

  it("lets the platform owner pause any organization", async () => {
    mockPause.mockResolvedValue(platformState);
    render(<AiPausePanel />);

    const globex = (await screen.findByText("Globex")).closest(
      "tr"
    ) as HTMLElement;
    expect(globex.textContent).toContain("Paused by platform");
    // An owner's own pause is shown, and is not this switch.
    const initech = screen.getByText("Initech").closest("tr") as HTMLElement;
    expect(initech.textContent).toContain("Paused by its owner");
    expect(
      screen.getByRole("button", { name: "Pause AI for Initech" })
    ).toBeTruthy();

    await userEvent.click(
      screen.getByRole("button", { name: "Pause AI for Acme" })
    );
    expect(setAiOrganizationPausedByPlatform).toHaveBeenCalledWith(3, true);

    await userEvent.click(
      screen.getByRole("button", { name: "Resume AI for Globex" })
    );
    expect(setAiOrganizationPausedByPlatform).toHaveBeenCalledWith(4, false);
  });

  it("searches organizations by name", async () => {
    mockPause.mockResolvedValue(platformState);
    render(<AiPausePanel />);

    await userEvent.type(
      await screen.findByLabelText("Search organizations"),
      "glo"
    );

    await waitFor(() => expect(mockPause).toHaveBeenLastCalledWith("glo"));
  });

  it("shows why a change failed", async () => {
    mockPause.mockResolvedValue(orgState);
    (
      setAiMemberPaused as unknown as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("forbidden"));
    render(<AiPausePanel />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Pause AI for asha" })
    );

    expect(await screen.findByText("forbidden")).toBeTruthy();
  });
});
