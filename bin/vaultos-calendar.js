#!/usr/bin/env node
'use strict';
// vaultos-calendar <command> …: the VaultOS calendar for agents in a VaultOS terminal (lib/calendar-cli.js).
require('../lib/calendar-cli').main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
