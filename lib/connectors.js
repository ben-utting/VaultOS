'use strict';
// What connectors exist, and the entry each one needs in an agent's MCP config.
const path = require('node:path');

const CONNECTORS = {
  atlassian: {
    id: 'atlassian',
    label: 'Atlassian',
    by: 'Jira · Confluence',
    kind: 'relayed',
    signIn: ['oauth', 'token'],
    base: 'https://mcp.atlassian.com',
    mcpPath: '/v1/mcp',
    metadataPath: '/.well-known/oauth-authorization-server',
    tokenHelp: 'https://id.atlassian.com/manage-profile/security/api-tokens',
  },
  azure: {
    id: 'azure',
    label: 'Azure',
    by: 'Subscriptions · resources · Key Vault',
    kind: 'local',
    signIn: ['device-code'],
    detect: ['az', 'azmcp'],
    install: 'npm install -g --prefix ~/.local @azure/mcp@4.0.0-beta.3 && python3 -m venv ~/.local/share/azure-cli && ~/.local/share/azure-cli/bin/pip install azure-cli && ln -sf ~/.local/share/azure-cli/bin/az ~/.local/bin/az',
  },
  entra: {
    id: 'entra',
    label: 'Microsoft Entra',
    by: 'Users · groups · apps · sign-in logs',
    kind: 'builtin',
    signIn: ['azure'],
  },
  github: {
    id: 'github',
    label: 'GitHub',
    by: 'Repos · issues · pull requests',
    kind: 'relayed',
    signIn: ['token'],
    base: 'https://api.githubcopilot.com',
    mcpPath: '/mcp/',
    tokenHelp: 'https://github.com/settings/personal-access-tokens/new',
  },
  mslearn: {
    id: 'mslearn',
    label: 'Microsoft Learn',
    by: 'Microsoft docs and code samples',
    kind: 'relayed',
    signIn: ['none'],
    base: 'https://learn.microsoft.com',
    mcpPath: '/api/mcp',
  },
};

const PLANNED = [
  { id: 'm365', label: 'Microsoft 365', by: 'Mail · files · Teams (needs its own sign-in)', mono: 'M365' },
  { id: 'notion', label: 'Notion', by: 'Pages · databases', mono: 'N' },
  { id: 'homeassistant', label: 'Home Assistant', by: 'Devices · automations', mono: 'HA' },
  { id: 'n8n', label: 'n8n', by: 'Run your workflows', mono: 'n8n' },
  { id: 'linear', label: 'Linear', by: 'Issues · projects', mono: 'L' },
  { id: 'sentry', label: 'Sentry', by: 'Errors · releases', mono: 'S' },
];

// The env override (tests point it at a fake upstream) applies to every relayed connector.
function baseFor(id, env = process.env) {
  const c = Object.hasOwn(CONNECTORS, id) ? CONNECTORS[id] : null;
  if (c && c.kind === 'relayed' && env['CONNECTOR_UPSTREAM_' + id.toUpperCase()]) return env['CONNECTOR_UPSTREAM_' + id.toUpperCase()];
  return Object.hasOwn(CONNECTORS, id) ? CONNECTORS[id].base : undefined;
}

function entryFor(id, { port, key, home, allowChanges } = {}) {
  if (Object.hasOwn(CONNECTORS, id) && (CONNECTORS[id].kind === 'relayed' || CONNECTORS[id].kind === 'builtin')) {
    return { kind: 'http', url: `http://127.0.0.1:${port}/mcp/${id}`, headers: { 'X-VaultOS-Key': key } };
  }
  if (id === 'azure') {
    return {
      kind: 'stdio',
      command: path.join(home, '.local/bin/azmcp'),
      args: ['server', 'start', ...(allowChanges ? [] : ['--read-only'])],
    };
  }
  throw new Error(`Unknown connector: ${id}`);
}

module.exports = { CONNECTORS, PLANNED, baseFor, entryFor };
