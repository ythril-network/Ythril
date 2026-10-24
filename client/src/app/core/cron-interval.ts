/**
 * How many minutes pass between runs of a cron schedule, on average, or `null` when that cannot be said.
 *
 * The one question: "what is the typical gap between two runs of this schedule". A network's `syncSchedule` is a cron string
 * (five fields, or six with leading seconds, as node-cron takes it), and the re-read dialog turns a number of sync cycles into a
 * time by it (bundle-81, decision 42). It answers for the schedules a person writes: lists, ranges and steps in the minute and
 * hour fields, with day of month, month and day of week left open. It answers `null` for a schedule it does not read (a
 * restricted day, a month or weekday name, an empty string, which is manual sync), rather than a number that would pass for one,
 * so the caller says the cycles and no time. The gap is an average: `*\/7` fires nine times an hour, not every seven minutes.
 *
 * Not a validator: the server refuses what it cannot run (`sync/schedule.ts`), and a string this does not read is not wrong.
 */
const MINUTES_PER_DAY = 1440;

/** The values a cron field names inside [min, max], or null when the field is not in a form this reads. */
function fieldValues(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (!Number.isInteger(step) || step < 1) return null;
    let from = min;
    let to = max;
    if (m[1] !== '*') {
      const [a, b] = m[1]!.split('-');
      from = Number(a);
      // A lone number with a step ("5/20") runs from it to the end of the field; without a step it is that value alone.
      to = b !== undefined ? Number(b) : m[2] === undefined ? from : max;
    }
    if (from < min || to > max || from > to) return null;
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return values.size ? values : null;
}

export function cronIntervalMinutes(schedule: string | null | undefined): number | null {
  const fields = (schedule ?? '').trim().split(/\s+/).filter(Boolean);
  // Six fields start with seconds; only a fixed second is read (several runs a minute are not a sync schedule worth a figure).
  if (fields.length === 6) {
    if (!/^\d+$/.test(fields[0]!) && fields[0] !== '*') return null;
    fields.shift();
  }
  if (fields.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
  const open = (f: string) => f === '*' || f === '?';
  if (!open(dayOfMonth) || !open(month) || !open(dayOfWeek)) return null;
  const minutes = fieldValues(minute, 0, 59);
  const hours = fieldValues(hour, 0, 23);
  if (!minutes || !hours) return null;
  return Math.max(1, Math.round(MINUTES_PER_DAY / (minutes.size * hours.size)));
}
