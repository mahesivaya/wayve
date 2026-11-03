// Code Repo diff headers: the file type icon, and the name before its folder.
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DiffFileName } from "../../github/commitDiff";

const typeOf = (filename: string) => {
  const { unmount } = render(<DiffFileName filename={filename} />);
  const label = screen.getByRole("img").getAttribute("aria-label");
  unmount();
  return label;
};

describe("diff file name", () => {
  it("picks the type from the extension", () => {
    expect(typeOf("frontend/src/auth/AuthContext.tsx")).toBe(
      "TypeScript React"
    );
    expect(typeOf("backend/src/api_key.rs")).toBe("Rust");
    expect(typeOf("infra/postgres/init.sql")).toBe("SQL");
    expect(typeOf("README.MD")).toBe("Markdown");
  });

  it("recognises files named for what they are", () => {
    expect(typeOf("infra/nginx/Dockerfile")).toBe("Dockerfile");
    expect(typeOf("infra/justfile")).toBe("Shell script");
    expect(typeOf("frontend/package-lock.json")).toBe("Lock file");
    expect(typeOf("backend/.env.production")).toBe("Environment");
  });

  it("falls back to a plain file", () => {
    expect(typeOf("LICENSE")).toBe("File");
    expect(typeOf("archive.xyz")).toBe("File");
    expect(typeOf("constructor")).toBe("File");
    expect(typeOf("a.constructor")).toBe("File");
  });

  it("puts the name first and mutes its folder", () => {
    const { container } = render(
      <DiffFileName filename="frontend/src/auth/AuthContext.tsx" />
    );
    expect(
      container.querySelector(".github-commit-file-name")?.textContent
    ).toBe("AuthContext.tsxfrontend/src/auth/");
    expect(
      container.querySelector(".github-commit-file-dir")?.textContent
    ).toBe("frontend/src/auth/");
  });

  it("shows no folder for a file at the repo root", () => {
    const { container } = render(<DiffFileName filename="README.md" />);
    expect(container.querySelector(".github-commit-file-dir")).toBeNull();
  });

  it("keeps both full paths on a rename", () => {
    render(<DiffFileName filename="new/b.ts" previousFilename="old/a.ts" />);
    expect(screen.getByText("old/a.ts → new/b.ts")).toBeTruthy();
  });
});
