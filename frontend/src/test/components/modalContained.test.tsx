import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import Modal from "../../components/Modal";

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
});

const renderModal = (contained: boolean, onClose = vi.fn()) => {
  render(
    <>
      <input aria-label="elsewhere" />
      <Modal isOpen onClose={onClose} contained={contained} title="Form">
        <input aria-label="inside" />
      </Modal>
    </>
  );
  return onClose;
};

describe("Modal", () => {
  describe("over the whole window (default)", () => {
    it("locks page scrolling and restores it on close", () => {
      document.body.style.overflow = "auto";
      const { unmount } = render(
        <Modal isOpen onClose={vi.fn()}>
          body
        </Modal>
      );
      expect(document.body.style.overflow).toBe("hidden");
      unmount();
      expect(document.body.style.overflow).toBe("auto");
    });

    it("closes on Escape wherever it was pressed", () => {
      const onClose = renderModal(false);
      fireEvent.keyDown(screen.getByLabelText("elsewhere"), { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("is marked modal", () => {
      renderModal(false);
      const dialog = screen.getByRole("dialog");
      expect(dialog.getAttribute("aria-modal")).toBe("true");
      expect(dialog.className).toBe("modal-overlay");
    });
  });

  describe("contained", () => {
    it("leaves page scrolling alone", () => {
      document.body.style.overflow = "auto";
      const { unmount } = render(
        <Modal isOpen onClose={vi.fn()} contained>
          body
        </Modal>
      );
      expect(document.body.style.overflow).toBe("auto");
      unmount();
      expect(document.body.style.overflow).toBe("auto");
    });

    it("isn't marked modal, since the rest of the app stays usable", () => {
      renderModal(true);
      const dialog = screen.getByRole("dialog");
      expect(dialog.getAttribute("aria-modal")).toBe("false");
      expect(dialog.className).toContain("modal-overlay--contained");
    });

    it("closes on Escape from inside it", () => {
      const onClose = renderModal(true);
      fireEvent.keyDown(screen.getByLabelText("inside"), { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("closes on Escape when nothing has focus", () => {
      const onClose = renderModal(true);
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("ignores Escape pressed elsewhere on the page", () => {
      const onClose = renderModal(true);
      fireEvent.keyDown(screen.getByLabelText("elsewhere"), { key: "Escape" });
      expect(onClose).not.toHaveBeenCalled();
    });

    it("closes on a backdrop click but not a click inside", () => {
      const onClose = renderModal(true);
      fireEvent.click(screen.getByLabelText("inside"));
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("dialog"));
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
