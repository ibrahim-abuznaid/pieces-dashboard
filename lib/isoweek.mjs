// lib/isoweek.mjs
// ISO-8601 week math, UTC only. A "week window" is the 7 days ending on that
// week's Friday (Sat 00:00 → Fri 23:59), which is lossless and is already
// closed when the Saturday snapshot job runs.
const DAY = 86400000;

const toUTC = (d) => (d instanceof Date ? d : new Date(`${d}T00:00:00Z`));
const iso = (d) => d.toISOString().slice(0, 10);
const shift = (d, days) => new Date(d.getTime() + days * DAY);
// Monday = 0 … Sunday = 6
const isoDayIndex = (d) => (d.getUTCDay() + 6) % 7;

const thursdayOfWeek = (d) => shift(d, 3 - isoDayIndex(d));

export function isoWeekId(date) {
  const thu = thursdayOfWeek(toUTC(date));
  const year = thu.getUTCFullYear();
  const firstThu = thursdayOfWeek(new Date(Date.UTC(year, 0, 4)));
  const week = 1 + Math.round((thu.getTime() - firstThu.getTime()) / (7 * DAY));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export function mondayOfWeekId(weekId) {
  const m = /^(\d{4})-W(\d{2})$/.exec(weekId);
  if (!m) throw new Error(`bad week id: ${weekId}`);
  const [, year, week] = m;
  const firstThu = thursdayOfWeek(new Date(Date.UTC(Number(year), 0, 4)));
  const thu = shift(firstThu, (Number(week) - 1) * 7);
  return iso(shift(thu, -3));
}

export function windowForWeekId(weekId) {
  const monday = toUTC(mondayOfWeekId(weekId));
  return { start: iso(shift(monday, -2)), end: iso(shift(monday, 4)) };
}

export function latestCompleteWeek(today) {
  const d = toUTC(today);
  // Friday = index 4. Walk back to the most recent Friday, inclusive.
  const back = (isoDayIndex(d) - 4 + 7) % 7;
  return isoWeekId(shift(d, -back));
}

// The latest week that is entirely IN THE PAST -- every one of its seven days
// done, today not among them.
//
// `latestCompleteWeek` above counts the current Friday as complete, which was
// true enough while this only ever ran at 09:00 on a Saturday: by then the
// Friday was over. It stops being true the moment the job is allowed to run on
// any other day, and a job that runs daily WILL land on a Friday -- where the
// older helper would hand it a week whose last day still has fourteen hours of
// work left in it, and seal that as the week's final number.
//
// Defined as "yesterday's complete week" rather than by re-deriving the
// calendar: the two would have to agree about ISO week boundaries in two
// places, and they would eventually stop.
export function latestSealedWeek(today) {
  return latestCompleteWeek(shift(toUTC(today), -1));
}

export function previousWeekId(weekId) {
  return isoWeekId(shift(toUTC(mondayOfWeekId(weekId)), -7));
}
