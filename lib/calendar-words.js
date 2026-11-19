'use strict';
// How the calendar reads in plain text: the `vaultos-calendar` command's output and the briefing an agent
// opened from a reminder reads first (lib/calendar-brief.js). Pure functions over entry and occurrence shapes.
const CC = require('../public/calendar-core');

// 'YYYY-MM-DD' → 'Fri 20 Nov 2026'.
const longDate = (d) => {
  if (!CC.isDate(d)) return String(d);
  const [y, m, day] = d.split('-').map(Number);
  return `${CC.DAY_SHORT[CC.weekday(d)]} ${day} ${CC.MONTH_SHORT[m - 1]} ${y}`;
};
const whenText = (x) => (x.allDay ? 'All day' : `${x.start}${x.end ? `–${x.end}` : ''}`);
const MINUTES = { '5m': '5 min', '10m': '10 min', '15m': '15 min', '30m': '30 min', '1h': '1 hour', '1d': '1 day' };
function pingWords(x) {
  if (!x.ping) return 'no ping';
  if (x.allDay) return x.ping === '1d' ? 'pings at 08:00 the day before' : 'pings at 08:00';
  return x.ping === 'start' ? 'pings at start' : `pings ${MINUTES[x.ping] || x.ping} before`;
}
const whoText = (w) => (w && w.kind === 'agent' ? w.agent || 'an agent' : 'the person');

module.exports = { longDate, whenText, pingWords, whoText };
