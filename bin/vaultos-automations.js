#!/usr/bin/env node
'use strict';
// vaultos-automations <command> …: automations for agents in a VaultOS terminal (lib/automation-cli.js).
require('../lib/automation-cli').main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
