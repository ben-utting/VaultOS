'use strict';
// Host-header allowlist. VaultOS can listen on localhost with a real shell
// behind it, so a web page that rebinds its own DNS name to 127.0.0.1 must not
// reach it: the browser still sends the attacker's name in Host.

// "host", "host:port", "[v6]" or "[v6]:port" -> lowercase bare name, or null.
function bareHost(value) {
  const h = String(value).trim().toLowerCase();
  if (!h.startsWith('[') && (h.match(/:/g) || []).length > 1) return h; // an unbracketed IPv6 literal, as ALLOWED_HOSTS may list it
  const m = h.startsWith('[') ? /^\[([^\]]*)\](?::\d*)?$/.exec(h) : /^([^:]*)(?::\d*)?$/.exec(h);
  return m ? m[1] : null;
}

// "localhost, 127.0.0.1" -> Set of bare lowercase names. Entries are parsed like a
// Host header, so "mybox.lan:7684" and "[::1]" work; empty entries are dropped.
function parseAllowedHosts(value = 'localhost,127.0.0.1') {
  return new Set(String(value).split(',').map(bareHost).filter(Boolean));
}

// hostHeader is the raw Host header. The port is ignored; "[::1]:7684" -> "::1".
function hostAllowed(hostHeader, allowed) {
  if (typeof hostHeader !== 'string' || !hostHeader) return false;
  const name = bareHost(hostHeader);
  return name !== null && allowed.has(name);
}

// The host name (port stripped) made safe to echo in a text body or a log line;
// it is what the user should put in ALLOWED_HOSTS.
function safeHost(hostHeader) {
  const raw = String(hostHeader == null ? '' : hostHeader);
  const name = bareHost(raw);
  return (name === null ? raw : name).replace(/[^A-Za-z0-9.:[\]-]/g, '').slice(0, 100);
}

module.exports = { parseAllowedHosts, hostAllowed, safeHost };
