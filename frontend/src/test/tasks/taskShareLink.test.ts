import { describe, expect, it } from "vitest";
import {
  taskShareText,
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
