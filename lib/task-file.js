'use strict';
// task.md helpers shared by the server and the automations runner. Each takes the file's text and
// returns new text; nothing here touches the disk. Moved out of server.js unchanged, except that
// section headings are now regex-escaped.

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Deliberately a small YAML subset: `key: value`, optionally quoted. That is all the
// task template uses, and a full YAML parser would invite formats the writer can't
// round-trip safely later.
function parseFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const rawVal = kv[2].trim();
    // A quoted scalar's content is verbatim between the matching quotes — it must never
    // go through comment-stripping, or a title/value that legitimately contains '#'
    // (a ticket number in parens, a hex colour, ...) gets silently truncated.
    // Double quotes honour the \" and \\ escapes; single quotes honour ''.
    const qm = /^"((?:[^"\\]|\\.)*)"|^'((?:[^']|'')*)'/.exec(rawVal);
    if (qm) {
      meta[kv[1]] = qm[1] !== undefined ? qm[1].replace(/\\(["\\])/g, '$1') : qm[2].replace(/''/g, "'");
      continue;
    }
    const v = rawVal.replace(/\s+#.*$/, '').trim();
    // Inline list: `stack: [a, b, c]` → array. Only KB articles use this; task.md never
    // has bracketed values, so existing files are unaffected.
    if (v.startsWith('[') && v.endsWith(']')) {
      meta[kv[1]] = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      continue;
    }
    meta[kv[1]] = v;
  }
  return { meta, body: m[2] };
}

// Replace a single frontmatter field in place, leaving the rest of the file byte-identical.
function setFrontmatterField(raw, key, value) {
  const m = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(raw);
  if (!m) throw new Error('No frontmatter block');
  const re = new RegExp(`^(${key}:[ \\t]*).*$`, 'm');
  let fm = m[2];
  const quoted = /[:#"\\]/.test(value) || value !== value.trim()
    ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : value;
  fm = re.test(fm) ? fm.replace(re, (_, p1) => p1 + quoted) : `${fm}\n${key}: ${quoted}`;
  return raw.slice(0, m[1].length) + fm + raw.slice(m[1].length + m[2].length);
}

// Insert lines into a `## <heading>` section of the body, touching nothing else.
// Creates the section at the end of the file when missing. 'top' inserts just under
// the heading (Progress log is newest-first); 'bottom' inserts at the section's end
// (Comments read as a thread, oldest first).
function insertInSection(raw, heading, entry, position) {
  const m = /^(---\r?\n[\s\S]*?\r?\n---\r?\n?)([\s\S]*)$/.exec(raw);
  const head = m ? m[1] : '';
  const lines = (m ? m[2] : raw).split('\n');
  const isHeading = (l) => new RegExp(`^##\\s+${escapeRe(heading)}\\s*$`, 'i').test(l.trim());
  let start = -1;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue; }
    if (!inFence && isHeading(lines[i])) { start = i; break; }
  }
  if (start === -1) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push('', `## ${heading}`, '', ...entry, '');
    return head + lines.join('\n');
  }
  let end = lines.length;                      // first line after the section
  inFence = false;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue; }
    if (!inFence && /^##\s/.test(lines[i])) { end = i; break; }
  }
  let at;
  if (position === 'top') {
    at = start + 1;
    if (at < end && lines[at].trim() === '') at++; // keep the blank line under the heading
  } else {
    at = end;
    while (at > start + 1 && lines[at - 1].trim() === '') at--; // land after the last real line
  }
  lines.splice(at, 0, ...entry);
  return head + lines.join('\n');
}

// Replace one `## <heading>` section's lines (up to the next `## ` heading or the end of the file)
// with contentLines, touching nothing else. A missing section goes in directly above the body's first
// `## ` heading (so callouts at the top stay on top), or at the end when there is no heading. Headings
// inside code fences are never matched. CRLF files stay CRLF.
function replaceSection(raw, heading, contentLines) {
  const crlf = raw.includes('\r\n');
  const text = crlf ? raw.replace(/\r\n/g, '\n') : raw;
  const m = /^(---\n[\s\S]*?\n---\n?)([\s\S]*)$/.exec(text);
  const head = m ? m[1] : '';
  const lines = (m ? m[2] : text).split('\n');
  const target = new RegExp(`^##\\s+${escapeRe(heading)}\\s*$`, 'i');
  const block = [`## ${heading}`, ...contentLines, ''];
  let start = -1;
  let first = -1;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue; }
    if (inFence || !/^##\s/.test(lines[i])) continue;
    if (first === -1) first = i;
    if (target.test(lines[i].trim())) { start = i; break; }
  }
  if (start !== -1) {
    let end = lines.length;
    inFence = false;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue; }
      if (!inFence && /^##\s/.test(lines[i])) { end = i; break; }
    }
    lines.splice(start, end - start, ...block);
  } else if (first !== -1) {
    const lead = first > 0 && lines[first - 1].trim() !== '' ? [''] : [];
    lines.splice(first, 0, ...lead, ...block);
  } else {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push('', ...block);
  }
  const out = head + lines.join('\n');
  return crlf ? out.replace(/\n/g, '\r\n') : out;
}

module.exports = { parseFrontmatter, setFrontmatterField, insertInSection, replaceSection, escapeRe };
