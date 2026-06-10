type EventType = {
  id: number;
  title: string;
  start: number; // minutes (e.g., 540 = 9:00)
  end: number;
};

export default function EventBlock({ event }: { event: EventType }) {
  const top = (event.start % 60) * 2; // pixels per minute
  const height = (event.end - event.start) * 2;

  return (
    <div
      className="event-block"
      style={{
        position: "absolute", // ✅ REQUIRED
        top: `${top}px`,
        height: `${height}px`,
        left: "2px",
        right: "2px",
      }}
    >
      {event.title}
    </div>
  );
}
