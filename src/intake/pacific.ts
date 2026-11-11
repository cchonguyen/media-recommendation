const DAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  weekday: "short",
  hour: "numeric",
  hourCycle: "h23",
});

/** Day of week (0 Sunday to 6 Saturday) and hour (0 to 23) in Pacific time. Handles DST. */
export function pacificDayAndHour(date: Date): { dayOfWeekPt: number; hourOfDayPt: number } {
  let day = 0;
  let hour = 0;
  for (const part of formatter.formatToParts(date)) {
    if (part.type === "weekday") day = DAYS[part.value] ?? 0;
    if (part.type === "hour") hour = Number(part.value) % 24;
  }
  return { dayOfWeekPt: day, hourOfDayPt: hour };
}
