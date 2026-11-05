import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Avatar from "../../components/Avatar";

describe("Avatar", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows the grey silhouette when there is no picture", () => {
    const { container } = render(<Avatar src={null} />);
    const circle = container.firstElementChild as HTMLElement;
    expect(circle.style.background).toBe("rgb(148, 163, 184)");
    expect(container.querySelector("img")).toBeNull();
  });

  // A transparent logo in dark ink would vanish on a dark surface.
  it("puts a loaded picture on a white, ringed backing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(new Blob(["x"]), { status: 200 }))
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:avatar");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const { container } = render(<Avatar src="/api/users/1/avatar" />);
    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());

    const circle = container.firstElementChild as HTMLElement;
    expect(circle.style.background).toBe("rgb(255, 255, 255)");
    expect(circle.style.boxShadow).toContain("var(--color-border)");
  });
});
