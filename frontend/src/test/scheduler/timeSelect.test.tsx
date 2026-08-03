import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import TimeSelect from "../../scheduler/TimeSelect";
import { formatHour, toTime } from "../../scheduler/dateUtils";

const QUARTER_HOURS = Array.from({ length: 96 }, (_, i) => ({
  value: toTime(i * 15),
  label: formatHour(i * 15),
}));

function Harness({
  initial = "10:45",
  minMins,
}: {
  initial?: string;
  minMins?: number;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <TimeSelect
        id="start"
        value={value}
        options={QUARTER_HOURS}
        onChange={setValue}
        minMins={minMins}
      />
      <output data-testid="value">{value}</output>
    </>
  );
}

const currentValue = () => screen.getByTestId("value").textContent;

describe("TimeSelect", () => {
  it("shows the current time and opens the preset list on focus", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const input = screen.getByRole("combobox");
    expect(input).toHaveValue("10:45 AM");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    await user.click(input);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /10:45 AM/ })).toBeInTheDocument();
  });

  it("picks a preset from the list", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: /^11:15 AM$/ }));

    expect(currentValue()).toBe("11:15");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("accepts a typed time on a non-quarter minute", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const input = screen.getByRole("combobox");
    await user.click(input);
    await user.clear(input);
    await user.type(input, "10:47");

    // Offered as an ordinary row on top of the presets, no "custom" labelling.
    const [first] = screen.getAllByRole("option");
    expect(first).toHaveTextContent("10:47 AM");
    expect(screen.queryByText(/custom/i)).not.toBeInTheDocument();

    await user.keyboard("{Enter}");
    expect(currentValue()).toBe("10:47");
  });

  it("accepts compact and meridiem entry, committing on blur", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const input = screen.getByRole("combobox");
    await user.click(input);
    await user.clear(input);
    await user.type(input, "347pm");
    await user.tab();

    expect(currentValue()).toBe("15:47");
    expect(screen.getByRole("combobox")).toHaveValue("3:47 PM");
  });

  it("keeps the value when the text isn't a time", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const input = screen.getByRole("combobox");
    await user.click(input);
    await user.clear(input);
    await user.type(input, "lunchtime");
    expect(input).toHaveAttribute("aria-invalid", "true");

    await user.tab();
    expect(currentValue()).toBe("10:45");
  });

  it("rejects a typed time that violates the lower bound", async () => {
    const user = userEvent.setup();
    // End time bounded by a 10:45 start: 9:30 is a real time but not allowed.
    render(<Harness initial="11:15" minMins={645} />);

    const input = screen.getByRole("combobox");
    await user.click(input);
    await user.clear(input);
    await user.type(input, "9:30");
    await user.tab();

    expect(currentValue()).toBe("11:15");
  });
});
