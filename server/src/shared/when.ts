// When something happened, said by calendar day in the viewer's time zone: "Today", "Yesterday",
// or a date. The conversation's day divider and the Details pane's Started and Last activity use
// these, so the same instant always reads the same way in both. Pure; `now` is passed in.

const MS_PER_DAY = 86_400_000;

/** Calendar days from `then` to `now` in local time: 0 the same day, 1 the day before. */
export function daysBetween(then: number, now: number): number {
  const start = (t: number) => {
    const d = new Date(t);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  };
  return Math.round((start(now) - start(then)) / MS_PER_DAY);
}

function dateText(at: number, now: number): string {
  const d = new Date(at);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
}

/** The day an instant falls on: "Today", "Yesterday", or a date ("12 Nov"; with the year when it is another year). */
export function dayLabel(at: number, now: number): string {
  const days = daysBetween(at, now);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return dateText(at, now);
}

/** The time of day, as the viewer's locale writes it ("14:05"). */
export const clockTime = (at: number): string => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** An instant by its day and time: "today 14:05", "yesterday 09:12", "12 Nov 09:12". */
export function whenText(at: number, now: number): string {
  const days = daysBetween(at, now);
  const day = days === 0 ? 'today' : days === 1 ? 'yesterday' : dateText(at, now);
  return `${day} ${clockTime(at)}`;
}

/** The hour and minute without a leading zero, as the viewer's locale writes it ("3:42 PM", "15:42"). */
export const shortTime = (at: number): string => new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** When something finished: the time when it was today, with the date before it when it was an earlier day ("12 Nov, 3:42 PM"). */
export function finishedText(at: number, now: number): string {
  return daysBetween(at, now) <= 0 ? shortTime(at) : `${dateText(at, now)}, ${shortTime(at)}`;
}
