import { useEffect, useState } from "react";
import { loadMarked, renderUntrustedMarkdown } from "../utils/markdown";

// One assistant reply. Models answer in Markdown, so it is formatted (bold,
// lists, quotes, code) instead of shown as source. The text is model output and
// can carry whatever a tool result or a pasted document told the model to say,
// so it goes through renderUntrustedMarkdown, with images dropped: an image URL
// is fetched without a click and could carry chat content out in its query.
//
// Until marked has loaded, and if it fails to, the reply shows as plain text.
export default function AiReply({ content }: { content: string }) {
  const [rendered, setRendered] = useState<{
    source: string;
    html: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadMarked()
      .then((parse) => {
        if (cancelled) return;
        setRendered({
          source: content,
          html: renderUntrustedMarkdown(parse, content, { images: false }),
        });
      })
      .catch(() => {
        // Plain text stays.
      });
    return () => {
      cancelled = true;
    };
  }, [content]);

  if (rendered?.source !== content) {
    return <div className="ai-msg-bubble">{content}</div>;
  }
  return (
    <div
      className="ai-msg-bubble ai-msg-rich"
      dangerouslySetInnerHTML={{ __html: rendered.html }}
    />
  );
}
