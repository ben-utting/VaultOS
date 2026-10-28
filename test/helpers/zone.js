'use strict';
// A time zone where it is a given hour right now, so a test (or the KB preview) can put
// the server inside or outside the morning read's window without faking its clock.
// Etc/GMT names are sign-inverted: Etc/GMT-8 is UTC+8. They run from -14 to +12.
function zoneAtHour(hour, now = Date.now()) {
  let offset = hour - new Date(now).getUTCHours();
  if (offset > 14) offset -= 24;
  if (offset < -12) offset += 24;
  if (offset === 0) return 'Etc/GMT';
  return `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;
}

module.exports = { zoneAtHour };
