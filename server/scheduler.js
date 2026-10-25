// The in-app scheduler, ported from Job-Agent's: runs the sync, the weekly review, the encrypted backup and the backup
// restore test at set times while the server runs, so the same schedule works on the PC and on the server (no Task
// Scheduler, no cron). Times are in the owner's time zone (OWNER_TZ, tools/time.js), never the host's, so a server on
// UTC still syncs at 7:00 New York time. Each job is set by an environment variable and is off when it is unset (a local
// copy with the lines commented out never runs jobs):
//   SCHEDULE_SYNC="daily 07:00"
//   SCHEDULE_REVIEW="Sun,Mon,Tue 08:00 | Sun 13:00"   Sunday afternoon, Monday and Tuesday are catch-ups: the job does
//                                             nothing once the week's review exists (jobs/review.js)
//   SCHEDULE_BACKUP="daily 23:00"
//   SCHEDULE_RESTORE_TEST="monthly 1 05:00"   on that day of the month (1 to 28)
// A spec is a day list (daily, weekdays, weekends, names like Mon,Thu, or "monthly N") and a 24-hour time (HH:MM);
// several, separated by "|", run the job at each of them.
// A run missed while the server was off runs when it comes back, if the missed time was within the last 12 hours and the
// job has not run since. A job never overlaps itself: not while it is running here, and not while a run of the same name
// started in the last 30 minutes is still marked running (a terminal command, Sync now).
import { addDays } from '../metrics/stats.js';
import { localDate, ownerTz, zonedInstant } from '../tools/time.js';

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const FULL_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const GROUPS = { daily: [0, 1, 2, 3, 4, 5, 6], weekdays: [1, 2, 3, 4, 5], weekends: [0, 6] };
export const CATCH_UP_HOURS = 12;
export const RUNNING_STALE_MINUTES = 30;
const CHECK_EVERY_MS = 30 * 1000;

/** The schedule variables: [job name, variable]. */
export const SCHEDULE_ENV = [['sync', 'SCHEDULE_SYNC'], ['review', 'SCHEDULE_REVIEW'], ['backup', 'SCHEDULE_BACKUP'], ['restore-test', 'SCHEDULE_RESTORE_TEST']];

/**
 * Parses "Sun,Mon,Tue 08:00", "daily 23:00", "weekdays 7:30" or "monthly 1 05:00", or several of them separated by "|"
 * ("Sun,Mon,Tue 08:00 | Sun 13:00"; then { spec, parts }). Throws a message that says what is wrong.
 */
export function parseSchedule(spec) {
  const pieces = String(spec ?? '').split('|').map((p) => p.trim());
  if (pieces.length > 1) {
    if (pieces.some((p) => !p)) throw new Error(`"${spec}": a "|" needs a schedule on each side.`);
    return { spec: pieces.join(' | '), parts: pieces.map(parseOne) };
  }
  return parseOne(pieces[0]);
}

function parseOne(spec) {
  const text = String(spec ?? '').trim();
  const monthly = /^monthly\s+(\d{1,2})\s+(\d{1,2}):(\d{2})$/i.exec(text);
  const m = monthly ? null : /^([a-z,\s]+?)\s+(\d{1,2}):(\d{2})$/i.exec(text);
  if (!monthly && !m) throw new Error(`"${spec}" is not a schedule; use days and a time, like "Sun,Mon,Tue 08:00", "daily 23:00" or "monthly 1 05:00".`);
  const [hh, mm] = monthly ? [monthly[2], monthly[3]] : [m[2], m[3]];
  const hour = Number(hh);
  const minute = Number(mm);
  if (hour > 23 || minute > 59) throw new Error(`"${spec}": the time must be between 00:00 and 23:59.`);
  if (monthly) {
    const monthDay = Number(monthly[1]);
    if (monthDay < 1 || monthDay > 28) throw new Error(`"${spec}": the day of the month must be 1 to 28 (every month has it).`);
    return { spec: text, monthDay, days: null, hour, minute };
  }
  const days = new Set();
  for (const part of m[1].toLowerCase().split(/[\s,]+/).filter(Boolean)) {
    if (GROUPS[part]) GROUPS[part].forEach((d) => days.add(d));
    else {
      const d = DAY_NAMES.indexOf(part.slice(0, 3));
      if (d < 0 || !FULL_NAMES[d].startsWith(part)) throw new Error(`"${spec}": "${part}" is not a day.`);
      days.add(d);
    }
  }
  return { spec: text, monthDay: null, days, hour, minute };
}

const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
const matches = (s, date) => (s.monthDay ? Number(date.slice(8, 10)) === s.monthDay : s.days.has(weekday(date)));
const SEARCH_DAYS = 32; // a monthly schedule's next day is at most a month away

/** The next scheduled instant strictly after `from`, the time read on the owner's wall clock. */
export function nextRun(s, from = new Date(), tz = ownerTz()) {
  if (s.parts) return s.parts.map((p) => nextRun(p, from, tz)).filter(Boolean).sort((a, b) => a - b)[0] ?? null;
  const today = localDate(from, tz);
  for (let i = 0; i <= SEARCH_DAYS; i += 1) {
    const date = addDays(today, i);
    if (!matches(s, date)) continue;
    const t = zonedInstant(date, s.hour, s.minute, tz);
    if (t > from) return t;
  }
  return null;
}

/** The latest scheduled instant at or before `when`. */
export function lastRun(s, when = new Date(), tz = ownerTz()) {
  if (s.parts) return s.parts.map((p) => lastRun(p, when, tz)).filter(Boolean).sort((a, b) => b - a)[0] ?? null;
  const today = localDate(when, tz);
  for (let i = 0; i <= SEARCH_DAYS; i += 1) {
    const date = addDays(today, -i);
    if (!matches(s, date)) continue;
    const t = zonedInstant(date, s.hour, s.minute, tz);
    if (t <= when) return t;
  }
  return null;
}

/** The jobs set in the environment: [{ name, schedule }]. Throws on a bad spec, so a typo never silently disables a job. */
export function schedulesFromEnv(env = process.env) {
  const jobs = [];
  for (const [name, key] of SCHEDULE_ENV) if (env[key]?.trim()) jobs.push({ name, schedule: parseSchedule(env[key]) });
  return jobs;
}

/**
 * @param {object} o
 * @param {Array<{ name: string, schedule: object, run: () => Promise<void> }>} o.jobs  run resolves when the job is done
 * @param {{ lastRanAt: (name) => string|null, isRunning: (name, now) => boolean }} o.runs  jobRunsLookup(db) (server/admin-queries.js)
 * @param {() => Date} [o.now]
 * @param {string} [o.tz]
 * @param {{ info: Function, warn: Function }} [o.log]
 * @param {(fn: Function, ms: number) => any} [o.every]  setInterval (injectable for tests)
 */
export function createScheduler({ jobs, runs, now = () => new Date(), tz = ownerTz(), log = console, every = setInterval, clear = clearInterval }) {
  const state = jobs.map((j) => ({ ...j, next: nextRun(j.schedule, now(), tz), running: false, lastResult: null }));
  let timer = null;

  const fire = async (job, why) => {
    if (job.running) return;
    if (runs.isRunning(job.name, now())) {
      log.info?.(`[schedule] ${job.name}: already running elsewhere, skipped (${why})`);
      return;
    }
    job.running = true;
    log.info?.(`[schedule] ${job.name}: starting (${why})`);
    try {
      await job.run();
      job.lastResult = 'ok';
      log.info?.(`[schedule] ${job.name}: done`);
    } catch (err) {
      job.lastResult = 'failed';
      log.warn?.(`[schedule] ${job.name}: failed (${err.name})`);
    } finally {
      job.running = false;
    }
  };

  const tick = () => {
    const t = now();
    for (const job of state) {
      if (job.next && t >= job.next) {
        job.next = nextRun(job.schedule, t, tz);
        fire(job, 'scheduled');
      }
    }
  };

  return {
    /** Starts checking, after running any job whose last scheduled time was missed within CATCH_UP_HOURS. */
    start() {
      const t = now();
      for (const job of state) {
        const missed = lastRun(job.schedule, t, tz);
        const ran = runs.lastRanAt(job.name);
        if (missed && t - missed <= CATCH_UP_HOURS * 3600 * 1000 && (!ran || new Date(ran) < missed)) fire(job, 'missed while the server was off');
      }
      timer = every(tick, CHECK_EVERY_MS);
      timer?.unref?.();
      for (const job of state) log.info?.(`[schedule] ${job.name}: ${job.schedule.spec} (${tz}), next ${job.next?.toISOString() ?? 'never'}`);
      return this;
    },
    stop() {
      if (timer) clear(timer);
      timer = null;
    },
    tick,
    /** Each job, its schedule, when it runs next (ISO) and whether it is running. */
    status: () => state.map((j) => ({ name: j.name, schedule: j.schedule.spec, next: j.next?.toISOString() ?? null, running: j.running, lastResult: j.lastResult })),
  };
}
