import { useState } from "react";

type EventType = {
  id: number;
  title: string;
  start: number;
  end: number;
};

type Props = {
  events: EventType[];
  onCreateEvent: (event: EventType) => void;
};

export default function TimeGrid({ events, onCreateEvent }: Props) {
  const [dragStart, setDragStart] = useState<number | null>(null);

  const hours = Array.from({ length: 24 }, (_, i) => i);

  const getMinutesFromEvent = (
    e: React.MouseEvent<HTMLDivElement>,
    hour: number
  ) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;

    const minutes = Math.floor((y / rect.height) * 60);

    return hour * 60 + minutes;
  };

  const handleMouseDown = (
    e: React.MouseEvent<HTMLDivElement>,
    hour: number
  ) => {
    setDragStart(getMinutesFromEvent(e, hour));
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLDivElement>, hour: number) => {
    if (dragStart === null) return;

    const end = getMinutesFromEvent(e, hour);

    const newEvent: EventType = {
      id: Date.now(),
      start: Math.min(dragStart, end),
      end: Math.max(dragStart, end),
      title: "New Event",
    };

    onCreateEvent(newEvent);
    setDragStart(null);
  };

  return (
    <div className="time-grid">
      {hours.map((hour) => (
        <div key={hour} className="hour-row">
          <div className="time-label">{hour}:00</div>

          <div
            className="hour-cell"
            onMouseDown={(e) => handleMouseDown(e, hour)}
            onMouseUp={(e) => handleMouseUp(e, hour)}
          >
            {events
              .filter((ev) => Math.floor(ev.start / 60) === hour)
              .map((ev) => (
                <div
                  key={ev.id}
                  className="event-block"
                  style={{
                    top: ev.start % 60,
                    height: ev.end - ev.start,
                  }}
                >
                  {ev.title}
                </div>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}
