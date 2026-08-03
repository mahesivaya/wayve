import { describe, expect, it } from "vitest";
import { parseTimeInput } from "../../scheduler/dateUtils";

describe("parseTimeInput", () => {
  it("parses 24-hour times", () => {
    expect(parseTimeInput("21:45")).toBe("21:45");
    expect(parseTimeInput("09:07")).toBe("09:07");
    expect(parseTimeInput("0:00")).toBe("00:00");
    expect(parseTimeInput("23:59")).toBe("23:59");
  });

  it("parses bare hours", () => {
    expect(parseTimeInput("9")).toBe("09:00");
    expect(parseTimeInput("17")).toBe("17:00");
  });

  it("parses separator-less entry as HMM / HHMM", () => {
    expect(parseTimeInput("930")).toBe("09:30");
    expect(parseTimeInput("1047")).toBe("10:47");
    expect(parseTimeInput("0007")).toBe("00:07");
  });

  it("parses meridiem forms", () => {
    expect(parseTimeInput("9 pm")).toBe("21:00");
    expect(parseTimeInput("10:47 AM")).toBe("10:47");
    expect(parseTimeInput("10:47pm")).toBe("22:47");
    expect(parseTimeInput("12 am")).toBe("00:00");
    expect(parseTimeInput("12 pm")).toBe("12:00");
    expect(parseTimeInput("7:05 p.m.")).toBe("19:05");
  });

  it("accepts any minute, not just quarter hours", () => {
    expect(parseTimeInput("10:47")).toBe("10:47");
    expect(parseTimeInput("3:01 pm")).toBe("15:01");
    expect(parseTimeInput("6:59")).toBe("06:59");
  });

  it("rejects non-times and out-of-range values", () => {
    expect(parseTimeInput("")).toBeNull();
    expect(parseTimeInput("   ")).toBeNull();
    expect(parseTimeInput("lunch")).toBeNull();
    expect(parseTimeInput("24:00")).toBeNull();
    expect(parseTimeInput("10:60")).toBeNull();
    expect(parseTimeInput("13 pm")).toBeNull();
    expect(parseTimeInput("0 am")).toBeNull();
    expect(parseTimeInput("12345")).toBeNull();
  });
});
