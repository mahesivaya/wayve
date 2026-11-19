// The new-channel form: a personal account picks who can join with radio
// buttons, each saying what it means; organizations get no choice.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ChannelCreateForm from "../../chat/components/ChannelCreateForm";
import type { ChannelVisibility } from "../../chat/types";

const renderForm = (
  visibility: ChannelVisibility,
  canChooseVisibility = true
) => {
  const onVisibilityChange = vi.fn();
  render(
    <ChannelCreateForm
      channelName=""
      visibility={visibility}
      canChooseVisibility={canChooseVisibility}
      error=""
      onChannelNameChange={vi.fn()}
      onVisibilityChange={onVisibilityChange}
      onCancel={vi.fn()}
      onCreate={vi.fn()}
    />
  );
  return onVisibilityChange;
};

describe("ChannelCreateForm visibility", () => {
  afterEach(() => cleanup());

  it("offers Private and Public as radio buttons, with what each means", () => {
    renderForm("private");
    const group = screen.getByRole("group", { name: "Who can join" });
    expect(group).toBeTruthy();
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.value)).toEqual(["private", "public"]);
    expect(screen.getByRole("radio", { name: /Private/ })).toHaveProperty(
      "checked",
      true
    );
    expect(screen.getByRole("radio", { name: /Public/ })).toHaveProperty(
      "checked",
      false
    );
    expect(screen.getByText(/Only people you add or invite/)).toBeTruthy();
    expect(
      screen.getByText(/Anyone with a personal account can join/)
    ).toBeTruthy();
    // The dropdown it replaces is gone.
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("reports the choice that is picked", () => {
    const onVisibilityChange = renderForm("private");
    fireEvent.click(screen.getByRole("radio", { name: /Public/ }));
    expect(onVisibilityChange).toHaveBeenCalledWith("public");
  });

  it("shows the current choice as checked", () => {
    renderForm("public");
    expect(screen.getByRole("radio", { name: /Public/ })).toHaveProperty(
      "checked",
      true
    );
  });

  it("offers no choice where every channel is public", () => {
    renderForm("private", false);
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("group", { name: "Who can join" })).toBeNull();
  });
});
