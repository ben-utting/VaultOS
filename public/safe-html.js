// Vault HTML goes through here before it reaches the page.
//
// The server renders markdown with marked, which passes raw HTML straight through, so an
// <img onerror=…> in any task, article, job doc, Files .md or note used to run script on
// VaultOS's own origin, where it could reach the terminals. The vault is written by agents,
// sync and pasted documents, not only by the owner, so every render site sanitises:
//
//   safeHtml(html)  rendered markdown: #d-body, #docv-body, the KB article, Files .md, Notes
//   safeSvg(svg)    a diagram's SVG: inline figures, the KB spotlight, the diagram viewer
//
// DOMPurify (public/purify.min.js, 3.4.17, loaded just before this file) does the work. The
// config was set by running it over every document and diagram on the live board: with the
// defaults it removed only `target` on screenshot links, and `role` / `text-transform` on
// diagrams, so those three are let back in. Anything else it strips was never in the vault.
//
// If DOMPurify failed to load, nothing renders as HTML: the source shows as escaped text.
// A page that looks wrong is the safe failure; running a document's script is not.
(function () {
  var P = window.DOMPurify;
  var ready = !!(P && P.isSupported);

  if (ready) {
    // A web link in a document opens in a new browser tab (from the installed app, the browser itself) instead of
    // replacing VaultOS. Links between notes (relative paths) stay in VaultOS: Files and the rest handle those.
    // mailto: needs nothing, it never leaves the page. Any link that opens a new tab (these, and screenshots that
    // carry target already) must not hand the new page window.opener or tell it where it came from.
    P.addHook('afterSanitizeAttributes', function (node) {
      if (node.nodeName !== 'A') return;
      if (/^\s*(https?:)?\/\//i.test(node.getAttribute('href') || '')) node.setAttribute('target', '_blank');
      if (node.hasAttribute('target')) node.setAttribute('rel', 'noopener noreferrer');
    });
  }

  var HTML = {
    ADD_ATTR: ['target'],
    // <style> would restyle the whole app and <form> could post a look-alike sign-in anywhere;
    // no document in the vault uses either.
    FORBID_TAGS: ['style', 'form'],
  };
  var SVG = {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_ATTR: ['role', 'text-transform'],
  };

  function escapeText(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function unsafe(s) {
    return '<pre class="safe-html-off">' + escapeText(s) + '</pre>';
  }

  window.safeHtml = function (html) {
    if (html == null || html === '') return '';
    return ready ? P.sanitize(String(html), HTML) : unsafe(html);
  };
  window.safeSvg = function (svg) {
    if (svg == null || svg === '') return '';
    return ready ? P.sanitize(String(svg), SVG) : unsafe(svg);
  };
})();
