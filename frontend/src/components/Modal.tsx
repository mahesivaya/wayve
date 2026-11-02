import React, { useEffect, useRef } from "react";
import "./Modal.css";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  // Opens over the nearest positioned ancestor rather than the whole window, which
  // leaves the rest of the app (and the other split pane) usable.
  contained?: boolean;
}

export default function Modal({
  isOpen,
  onClose,
  title,
  children,
  contained = false,
}: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  // Handle ESC key and scroll locking
  useEffect(() => {
    if (!isOpen) return;

    const handleEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Escape pressed elsewhere on the page isn't meant for a contained modal.
      const target = e.target;
      if (
        contained &&
        target instanceof Node &&
        target !== document.body &&
        !overlayRef.current?.contains(target)
      ) {
        return;
      }
      onClose();
    };

    window.addEventListener("keydown", handleEsc);
    // Prevent background scrolling when modal is open
    const originalOverflow = document.body.style.overflow;
    if (!contained) document.body.style.overflow = "hidden";

    return () => {
      window.removeEventListener("keydown", handleEsc);
      if (!contained) document.body.style.overflow = originalOverflow;
    };
  }, [isOpen, onClose, contained]);

  if (!isOpen) return null;

  return (
    <div
      ref={overlayRef}
      className={`modal-overlay${contained ? " modal-overlay--contained" : ""}`}
      onClick={onClose}
      role="dialog"
      aria-modal={!contained}
    >
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          {title && <h3 className="modal-title">{title}</h3>}
          <button
            className="modal-close-btn"
            onClick={onClose}
            aria-label="Close modal"
          >
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
