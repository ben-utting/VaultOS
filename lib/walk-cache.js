'use strict';
// A listing that costs a whole-vault walk (seconds on the network share the
// vault lives on), kept for maxAgeMs so the search panel and Files mode don't
// pay for a walk on every keystroke. Callers that arrive while a walk is
// running share it. invalidate() (the server calls it on every write request)
// makes the next get() walk again; a walk that was already running when it
// came still answers its own callers but is not kept, since it may have read
// the folder before the write landed. Past maxAgeMs the next get() waits for a
// fresh walk rather than answering from the old one, so what an agent wrote in
// a terminal shows within maxAgeMs.
// The value is shared between callers: they must not mutate it.
function createWalkCache(walk, { maxAgeMs = 30e3, now = Date.now } = {}) {
  let value = null;
  let at = 0;
  let inflight = null;
  let gen = 0;

  function get() {
    if (value && now() - at < maxAgeMs) return Promise.resolve(value);
    if (!inflight) {
      const g = gen;
      const p = Promise.resolve().then(walk).then((v) => {
        if (g === gen) { value = v; at = now(); }
        return v;
      }).finally(() => { if (inflight === p) inflight = null; });
      inflight = p;
    }
    return inflight;
  }

  function invalidate() {
    gen++;
    value = null;
    inflight = null;
  }

  return { get, invalidate };
}

module.exports = { createWalkCache };
