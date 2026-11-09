import type { ReactNode } from "react";

// Renders a note's text as a formatted document. A small Markdown subset:
//   # ## ###         headings
//   - * •  or 1.     bullets and numbered lists, nested by indentation
//   **text**         bold
// Everything becomes React elements and text nodes, so a note can't inject HTML.

type ListItem = { text: string; children: ListNode | null };
type ListNode = { ordered: boolean; start: number; items: ListItem[] };
type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; list: ListNode };

const HEADING = /^(#{1,3})\s+(.*)$/;
const LIST_ITEM = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/;

const newList = (marker: string): ListNode => {
  const ordered = /\d/.test(marker);
  return { ordered, start: ordered ? parseInt(marker, 10) : 1, items: [] };
};

function parseBlocks(content: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  // Open lists, outermost first, with the indent of each one's items.
  let stack: { indent: number; list: ListNode }[] = [];

  const endParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
      paragraph = [];
    }
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, "  ");
    const item = LIST_ITEM.exec(line);

    if (item) {
      endParagraph();
      const [, spaces, marker, text] = item;
      const indent = spaces.length;
      if (stack.length === 0) {
        const list = newList(marker);
        blocks.push({ kind: "list", list });
        stack = [{ indent, list }];
      } else if (indent > stack[stack.length - 1].indent) {
        const parent = stack[stack.length - 1].list;
        const list = newList(marker);
        parent.items[parent.items.length - 1].children = list;
        stack.push({ indent, list });
      } else {
        while (stack.length > 1 && indent < stack[stack.length - 1].indent) {
          stack.pop();
        }
      }
      stack[stack.length - 1].list.items.push({ text, children: null });
      continue;
    }

    stack = [];
    const heading = HEADING.exec(line);
    if (heading) {
      endParagraph();
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        text: heading[2],
      });
    } else if (line.trim() === "") {
      endParagraph();
    } else {
      paragraph.push(line);
    }
  }
  endParagraph();
  return blocks;
}

const renderInline = (text: string): ReactNode =>
  text
    .split(/(\*\*[^*]+\*\*)/)
    .map((part, index) =>
      part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
        <strong key={index}>{part.slice(2, -2)}</strong>
      ) : (
        part
      )
    );

function NoteList({ list }: { list: ListNode }) {
  const items = list.items.map((item, index) => (
    <li key={index}>
      {renderInline(item.text)}
      {item.children && <NoteList list={item.children} />}
    </li>
  ));
  return list.ordered ? <ol start={list.start}>{items}</ol> : <ul>{items}</ul>;
}

export default function NoteBody({ content }: { content: string }) {
  return (
    <div className="note-read-body">
      {parseBlocks(content).map((block, index) => {
        if (block.kind === "list") {
          return <NoteList key={index} list={block.list} />;
        }
        if (block.kind === "paragraph") {
          return <p key={index}>{renderInline(block.text)}</p>;
        }
        // The note's own title is the h2, so body headings start at h3.
        const Heading = `h${block.level + 2}` as "h3" | "h4" | "h5";
        return <Heading key={index}>{renderInline(block.text)}</Heading>;
      })}
    </div>
  );
}
