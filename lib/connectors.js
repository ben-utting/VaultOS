'use strict';
// What connectors exist, and the entry each one needs in an agent's MCP config.
const path = require('node:path');
const ado = require('./connector-ado');

const CONNECTORS = {
  atlassian: {
    id: 'atlassian',
    label: 'Atlassian',
    by: 'Jira · Confluence',
    kind: 'relayed',
    signIn: ['oauth', 'token'],
    base: 'https://mcp.atlassian.com',
    mcpPath: '/v2/mcp', // OAuth: v2 signs in through its own authorization server, found from this address
    tokenMcpPath: '/v1/mcp', // API tokens: Atlassian documents them for v1 only
    tokenHelp: 'https://id.atlassian.com/manage-profile/security/api-tokens',
  },
  vantage: {
    id: 'vantage',
    label: 'Vantage',
    by: 'Cloud costs · reports · budgets',
    kind: 'relayed',
    signIn: ['oauth', 'token'],
    base: 'https://mcp.vantage.sh',
    mcpPath: '/mcp',
    rootMetadata: true, // its path-specific resource metadata sits behind a challenge page: read the root one instead
    tokenHelp: 'https://docs.vantage.sh/api/authentication',
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
  // msapp: the person's own app registration (public client, device code). scopes are delegated only, never widened;
  // consent names what an admin would grant when the tenant blocks user consent.
  transcripts: {
    id: 'transcripts',
    label: 'Teams transcripts',
    by: 'Meeting transcripts from an app you register',
    kind: 'builtin',
    signIn: ['msapp'],
    scopes: ['OnlineMeetingTranscript.Read.All', 'OnlineMeetings.Read', 'Calendars.Read', 'User.Read', 'offline_access'],
  },
  teamschats: {
    id: 'teamschats',
    label: 'Teams chats',
    by: 'Your chats, read-only, from an app you register',
    kind: 'builtin',
    signIn: ['msapp'],
    scopes: ['User.Read', 'Chat.Read', 'offline_access'],
    consent: 'Chat.Read',
    cursorAlt: 'cursor-teams', // while that one is on, Cursor gets it instead of this
  },
  outlookmail: {
    id: 'outlookmail',
    label: 'Outlook mail',
    by: 'Your mail, read-only, from an app you register',
    kind: 'builtin',
    signIn: ['msapp'],
    scopes: ['User.Read', 'Mail.Read', 'offline_access'],
    consent: 'Mail.Read',
    cursorAlt: 'cursor-outlook',
  },
  outlookcalendar: {
    id: 'outlookcalendar',
    label: 'Outlook calendar',
    by: 'Your calendar, read-only, from an app you register',
    kind: 'builtin',
    signIn: ['msapp'],
    scopes: ['User.Read', 'Calendars.Read', 'offline_access'],
    consent: 'Calendars.Read',
    cursorAlt: 'cursor-outlook-calendar',
  },
  // Cursor's own Microsoft 365 servers, for the Cursor CLI only. Cursor signs in to them itself (its own Microsoft app,
  // and every request carries the Cursor login), so VaultOS only writes the entry and helps the CLI's sign-in finish.
  // They can change things: `scopes` is what Cursor asks Microsoft for, shown on the card.
  'cursor-teams': {
    id: 'cursor-teams',
    label: 'Teams (Cursor)',
    by: "Cursor's own Teams connector, for Cursor only",
    kind: 'cursor',
    signIn: ['cursor'],
    agents: ['cursor'],
    url: 'https://api.cursor.com/rest-mcp/teams/mcp',
    scopes: ['User.Read', 'Chat.Read', 'ChatMessage.Send', 'Team.ReadBasic.All', 'Channel.ReadBasic.All', 'ChannelMessage.Read.All', 'ChannelMessage.Send', 'offline_access'],
    sends: 'post in your chats and channels',
  },
  'cursor-outlook': {
    id: 'cursor-outlook',
    label: 'Outlook (Cursor)',
    by: "Cursor's own Outlook connector, for Cursor only",
    kind: 'cursor',
    signIn: ['cursor'],
    agents: ['cursor'],
    url: 'https://api.cursor.com/rest-mcp/outlook/mcp',
    scopes: ['User.Read', 'Mail.ReadWrite', 'Mail.Send', 'Contacts.Read', 'offline_access'],
    sends: 'send, move and delete your mail',
  },
  'cursor-outlook-calendar': {
    id: 'cursor-outlook-calendar',
    label: 'Outlook calendar (Cursor)',
    by: "Cursor's own Outlook calendar connector, for Cursor only",
    kind: 'cursor',
    signIn: ['cursor'],
    agents: ['cursor'],
    url: 'https://api.cursor.com/rest-mcp/outlook-calendar/mcp',
    scopes: ['User.Read', 'Calendars.ReadWrite', 'offline_access'],
    sends: 'create, change and delete your events',
  },
  azuredevops: {
    id: 'azuredevops',
    label: 'Azure DevOps',
    by: 'Work items · repos · pipelines · wiki',
    kind: 'local',
    signIn: ['azure'],
    detect: [ado.BIN],
    install: `npm install -g --prefix ~/.local ${ado.PACKAGE}`,
  },
  logicmonitor: {
    id: 'logicmonitor',
    label: 'LogicMonitor',
    by: 'Alerts · devices · metrics',
    kind: 'builtin',
    signIn: ['token'],
    tokenHelp: 'https://www.logicmonitor.com/support/bearer-token',
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
  context7: {
    id: 'context7',
    label: 'Context7',
    by: 'Current docs for code libraries',
    kind: 'relayed',
    signIn: ['token'],
    base: 'https://mcp.context7.com',
    mcpPath: '/mcp',
    tokenHelp: 'https://context7.com/dashboard',
  },
};

const PLANNED = [
  { id: 'm365', label: 'Microsoft 365 files', by: 'OneDrive · SharePoint', mono: 'M365' },
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

// allowChanges is the connector's own switch (Azure's or Azure DevOps'); org is Azure DevOps' organization.
function entryFor(id, { port, key, home, allowChanges, org } = {}) {
  if (Object.hasOwn(CONNECTORS, id) && CONNECTORS[id].kind === 'cursor') return { kind: 'http', url: CONNECTORS[id].url };
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
  if (id === 'azuredevops') return ado.entry({ home, org, allowChanges });
  throw new Error(`Unknown connector: ${id}`);
}

module.exports = { CONNECTORS, PLANNED, baseFor, entryFor };
