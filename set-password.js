'use strict';
// Usage: node set-password.js "your-password"
// Hashes the password with scrypt and writes config.json in DATA_DIR with a new
// sessionSecret (every browser signs in again once the server restarts) and resets any lockout.
const { MIN_PASSWORD, dataDirFrom, writePassword } = require('./lib/password');

const password = process.argv[2];
if (!password || password.length < MIN_PASSWORD) {
  console.error(`Usage: node set-password.js "your-password"  (min ${MIN_PASSWORD} chars)`);
  process.exit(1);
}

const dataDir = dataDirFrom(process.env);
writePassword(dataDir, password);
console.log(`Password set. config.json written to ${dataDir}, lockout reset.`);
