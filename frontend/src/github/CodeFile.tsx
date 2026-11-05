import { useMemo } from "react";
import { CodeTokens } from "./commitDiff";
import { useCodeSettings } from "./codeSettings";
import { languageFor, tokenizeLines } from "./syntaxHighlight";

// A whole file in the preview: line numbers beside syntax-coloured code. The
// numbers can't be selected, so copying takes only the code.
export function CodeFile({ path, text }: { path: string; text: string }) {
  const { wrapLines, lineNumbers } = useCodeSettings();
  const lines = useMemo(() => {
    const split = text.split(/\r?\n/);
    // A final newline ends the last line rather than starting another.
    if (split[split.length - 1] === "") split.pop();
    return split;
  }, [text]);
  const tokens = useMemo(
    () => tokenizeLines(lines, languageFor(path)),
    [lines, path]
  );

  if (!text) return <pre>No preview available.</pre>;

  return (
    <pre
      className={`github-code-file${wrapLines ? " is-wrapped" : ""}${
        lineNumbers ? "" : " no-line-numbers"
      }`}
    >
      {lines.map((line, idx) => (
        <span key={idx} className="github-code-file-line">
          <span className="github-code-file-no">{idx + 1}</span>
          <span className="github-code-file-text">
            <CodeTokens text={line} tokens={tokens?.[idx]} />
          </span>
        </span>
      ))}
    </pre>
  );
}
