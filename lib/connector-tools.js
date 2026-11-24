'use strict';
// Read-only tool filtering for a relayed connector: which tools agents may see and call, and rewriting a tools/list
// reply (plain JSON, or an SSE stream) to match. A filter is { allow(name), first: [...names], refusal(name) }:
// allowed tools are listed with `first` in that order, then the rest by name; a call to any other tool is refused
// with refusal(name). The relay applies these; nothing here does I/O.

// Vantage: only tools that read. Anything else, including tools Vantage adds later, is hidden until "Allow changes".
const VANTAGE_FIRST = [
  'query-costs', 'list-costs', 'list-cost-reports', 'get-cost-report', 'get-cost-report-forecast', 'list-budgets', 'get-budget',
  'list-budget-alerts', 'list-anomalies', 'get-anomaly', 'list-cost-alerts', 'list-cost-alert-events', 'list-cost-providers',
  'list-cost-services', 'list-cost-integrations', 'get-cost-provider-accounts', 'list-recommendations', 'get-recommendation-details',
  'list-resource-reports', 'get-resource-report', 'list-provider-resources', 'list-tags', 'list-tag-values', 'list-saved-filters',
  'list-folders', 'list-dashboards', 'list-workspaces', 'get-myself', 'list-unit-costs', 'list-financial-commitment-reports',
];
const VANTAGE_HIDDEN_READS = new Set(['list-ingest-tokens', 'list-enrichment-source-ingest-tokens']); // they list tokens

const vantageReadOnly = {
  allow: (name) => typeof name === 'string' && /^(get|list|query)-/.test(name) && !VANTAGE_HIDDEN_READS.has(name),
  first: VANTAGE_FIRST,
  refusal: (name) => `VaultOS lets agents read Vantage only. Turn on Allow changes in Settings → Connectors to use ${name}.`,
};

// Atlassian (Jira and Confluence) for automations: reads only. Writes and anything unrecognised are refused.
const atlassianReadOnly = {
  allow: (name) => typeof name === 'string' && (/^(get|search|lookup|list|fetch)([A-Z]|$)/.test(name) || name === 'atlassianUserInfo'),
  first: [],
  refusal: (name) => `VaultOS lets automations read Atlassian only, so ${name} is off.`,
};

// GitHub for automations: get_, list_ and search_ tools only.
const githubReadOnly = {
  allow: (name) => typeof name === 'string' && /^(get|list|search)_/.test(name),
  first: [],
  refusal: (name) => `VaultOS lets automations read GitHub only, so ${name} is off.`,
};

// The read-only filter an automation uses for a connector id, or null when it has none.
function automationFilter(id) {
  if (id === 'atlassian') return atlassianReadOnly;
  if (id === 'github') return githubReadOnly;
  if (id === 'vantage') return vantageReadOnly;
  return null;
}

// One JSON-RPC message: when it carries a tool list, that list filtered and ordered; anything else as it came.
function filterToolsMessage(msg, tools) {
  if (!msg || typeof msg !== 'object' || !msg.result || !Array.isArray(msg.result.tools)) return msg;
  const rank = new Map(tools.first.map((n, i) => [n, i]));
  const at = (t) => (rank.has(t.name) ? rank.get(t.name) : tools.first.length);
  const kept = msg.result.tools.filter((t) => t && tools.allow(t.name));
  kept.sort((a, b) => (at(a) - at(b)) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { ...msg, result: { ...msg.result, tools: kept } };
}

// A tools/list reply's body, rewritten. SSE events keep their other lines (event:, id:) and their order; each
// event's data lines are joined (with \n, as SSE says) and sent back as one. Throws on anything it can't parse,
// so the relay never passes an unfiltered list on.
function rewriteToolsList(text, contentType, tools) {
  if (/text\/event-stream/i.test(contentType || '')) {
    return text.split(/\r?\n\r?\n/).map((ev) => {
      if (!ev.trim()) return ev;
      const lines = ev.split(/\r?\n/);
      const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, ''));
      const joined = data.join('\n');
      if (!joined.trim()) return ev; // no data (or a priming event's empty data): nothing to filter
      const out = JSON.stringify(filterToolsMessage(JSON.parse(joined), tools));
      return [...lines.filter((l) => !l.startsWith('data:')), `data: ${out}`].join('\n');
    }).join('\n\n');
  }
  const body = JSON.parse(text);
  return JSON.stringify(Array.isArray(body) ? body.map((m) => filterToolsMessage(m, tools)) : filterToolsMessage(body, tools));
}

// The reply VaultOS gives itself for a call to a hidden tool, or null when the message isn't one.
function hiddenCallReply(msg, tools) {
  if (!msg || typeof msg !== 'object' || msg.method !== 'tools/call') return null;
  const name = msg.params && msg.params.name;
  if (tools.allow(name)) return null;
  return { jsonrpc: '2.0', id: msg.id === undefined ? null : msg.id, result: { isError: true, content: [{ type: 'text', text: tools.refusal(String(name)) }] } };
}

module.exports = {
  vantageReadOnly, atlassianReadOnly, githubReadOnly, automationFilter,
  filterToolsMessage, rewriteToolsList, hiddenCallReply,
};
