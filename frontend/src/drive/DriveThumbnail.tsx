import { useEffect, useRef, useState, type ReactNode } from "react";
import { fetchDriveFileBlob, type UploadedFile } from "../api/drive";
import { logger } from "../utils/logger";

const IMAGE_TYPES = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
]);
// Files are E2E-encrypted, so a preview means downloading + decrypting the whole
// blob client-side. Skip that for large images and fall back to the icon.
const MAX_THUMB_BYTES = 8 * 1024 * 1024;

type Props = {
  file: UploadedFile;
  userId: number | null;
  /** Icon shown for non-images, oversized files, before load, or on error. */
  fallback: ReactNode;
};

/**
 * A Drive file's icon box that, for image files, lazily renders a real preview:
 * when the row scrolls into view it fetches + decrypts the blob and shows it as
 * a small <img>. Otherwise (non-image, too large, still loading, or failed) it
 * shows `fallback`. Object URLs are revoked on unmount.
 */
export default function DriveThumbnail({ file, userId, fallback }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const boxRef = useRef<HTMLSpanElement | null>(null);

  const isImage =
    IMAGE_TYPES.has((file.file_type || "").toLowerCase()) &&
    file.size <= MAX_THUMB_BYTES &&
    userId != null;

  useEffect(() => {
    if (!isImage) return;
    const el = boxRef.current;
    if (!el) return;

    let cancelled = false;
    let objectUrl: string | null = null;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        observer.disconnect();
        void (async () => {
          try {
            const blob = await fetchDriveFileBlob(file.id, userId);
            if (cancelled) return;
            objectUrl = URL.createObjectURL(blob);
            setUrl(objectUrl);
          } catch (err) {
            logger.error("drive thumbnail load failed", err);
            if (!cancelled) setFailed(true);
          }
        })();
      },
      { rootMargin: "100px" }
    );
    observer.observe(el);

    return () => {
      cancelled = true;
      observer.disconnect();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.id, isImage, userId]);

  const showImage = isImage && url && !failed;

  return (
    <span
      ref={boxRef}
      className={`file-icon${showImage ? " file-thumb" : ""}`}
      aria-hidden="true"
    >
      {showImage ? (
        <img src={url} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : (
        fallback
      )}
    </span>
  );
}
