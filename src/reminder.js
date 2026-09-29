/* The bedtime reminder: when it goes off, and which diary day it is nagging about. Pure, like
   entry.js — it loads as a browser global and through require(), so the desktop's main
   process, the Android bridge and the tests all agree on the same few rules.

   A reminder is about the diary day it lands in, not the calendar day: with the day starting
   at 4am, a reminder set for 1am is asking about the evening before. And it only goes off if
   that day has not been written — an entry file exists only once something is typed in it,
   so "written" is simply "the file is there". */
const diaryReminder = (() => {
  const DEFAULT_TIME = '22:00';
  const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

  const pad = (value) => String(value).padStart(2, '0');

  /* 'HH:MM' in, { hour, minute } out, or null for anything else. */
  function parseTime(value) {
    const match = TIME_RE.exec(String(value == null ? '' : value).trim());
    return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
  }

  /* Accepts '9:05' as well as '09:05', since that is what a hand-edited file will contain. */
  function normaliseTime(value, fallback) {
    const loose = /^(\d{1,2}):(\d{2})$/.exec(String(value == null ? '' : value).trim());
    const time = loose ? parseTime(`${pad(loose[1])}:${loose[2]}`) : null;
    return time ? `${pad(time.hour)}:${pad(time.minute)}` : (fallback === undefined ? DEFAULT_TIME : fallback);
  }

  /* The next `count` moments the reminder is due, strictly after `now`. */
  function upcoming(now, time, count) {
    const at = parseTime(normaliseTime(time));
    const from = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
    const list = [];
    const next = new Date(from.getFullYear(), from.getMonth(), from.getDate(), at.hour, at.minute, 0, 0);
    if (next <= from) next.setDate(next.getDate() + 1);
    for (let i = 0; i < Math.max(0, Number(count) || 0); i += 1) {
      list.push(new Date(next.getTime()));
      next.setDate(next.getDate() + 1);
    }
    return list;
  }

  const nextAt = (now, time) => upcoming(now, time, 1)[0];

  /* The diary day a reminder going off at `at` is asking about. */
  function dayFor(at, dayStartHour) {
    const entry = typeof diaryEntry !== 'undefined' ? diaryEntry
      : (typeof require === 'function' ? require('./entry.js') : null);
    return entry.todayId(at, dayStartHour);
  }

  return { DEFAULT_TIME, parseTime, normaliseTime, upcoming, nextAt, dayFor };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = diaryReminder;
if (typeof window !== 'undefined') window.diaryReminder = diaryReminder;
