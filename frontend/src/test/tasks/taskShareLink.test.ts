import { describe, expect, it } from "vitest";
import {
  taskShareText,
  taskShareUrl,
  taskRefPath,
  peelTaskRefTrailing,
} from "../../tasks/taskShareLink";

describe("taskShareText", () => {
  it("uses task_number when present", () => {
    expect(
      taskShareText({ id: 99, task_number: 42, name: "Ship the thing" })
    ).toBe("#42 Ship the thing");
  });

  it("falls back to id when task_number is missing", () => {
    expect(
      taskShareText({ id: 99, task_number: null, name: "Imported issue" })
    ).toBe("#99 Imported issue");
  });
});

describe("taskShareUrl", () => {
  it("joins the origin and the detail path", () => {
    expect(taskShareUrl("/user-stories/17", "https://fluxze.com")).toBe(
      "https://fluxze.com/user-stories/17"
    );
  });

  it("does not double a trailing slash on the origin", () => {
    expect(taskShareUrl("/tickets/5", "https://fluxze.com/")).toBe(
      "https://fluxze.com/tickets/5"
    );
  });

  it("defaults to the current origin", () => {
    expect(taskShareUrl("/tickets/5")).toBe(
      `${window.location.origin}/tickets/5`
    );
  });
});

describe("taskRefPath", () => {
  it("builds an in-app ref route", () => {
    expect(taskRefPath(42)).toBe("/tasks?ref=42");
  });
});

describe("peelTaskRefTrailing", () => {
  it("peels trailing sentence punctuation off the task name", () => {
    expect(peelTaskRefTrailing("Ship the thing.")).toEqual([
      "Ship the thing",
      ".",
    ]);
  });
});
