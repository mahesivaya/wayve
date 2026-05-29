import { useMemo } from "react";
import { APP_TIME_ZONE } from "../utils/datetime";

type Props = {
  view: "day" | "week" | "month";
  currentDate: Date;
};

export default function CalendarHeader({
  view,
  currentDate,
}: Props) {

  const label = useMemo(() => {
    if (view === "month") {
      return currentDate.toLocaleDateString("en-US", {
        timeZone: APP_TIME_ZONE,
        month: "long",
        year: "numeric",
      });
    }

    if (view === "week") {
      const start = new Date(currentDate);
      start.setDate(currentDate.getDate() - currentDate.getDay());

      const end = new Date(start);
      end.setDate(start.getDate() + 6);

      return `${start.toLocaleDateString("en-US", {
        timeZone: APP_TIME_ZONE,
        month: "short",
        day: "numeric",
      })} - ${end.toLocaleDateString("en-US", {
        timeZone: APP_TIME_ZONE,
        month: "short",
        day: "numeric",
      })}`;
    }

    return currentDate.toLocaleDateString("en-US", {
      timeZone: APP_TIME_ZONE,
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  }, [currentDate, view]);

  return <div>{label}</div>;
}
