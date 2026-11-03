// Small in-memory rate limits (fixed windows, no dependency). Counters reset when the hub restarts.

/** A counter per key that allows `limit` hits per `windowMs`. limit 0 = off. */
export function limiter({ limit, windowMs }) {
  const hits = new Map(); // key -> { n, reset }
  const entry = (key) => {
    const t = Date.now();
    let e = hits.get(key);
    if (!e || e.reset <= t) { e = { n: 0, reset: t + windowMs }; hits.set(key, e); }
    return e;
  };
  setInterval(() => {
    const t = Date.now();
    for (const [k, e] of hits) if (e.reset <= t) hits.delete(k);
  }, windowMs).unref();
  return {
    /** Seconds until the key may try again, or 0 if it is under the limit. Doesn't count. */
    blocked(key) {
      if (!limit) return 0;
      const e = entry(key);
      return e.n >= limit ? Math.ceil((e.reset - Date.now()) / 1000) : 0;
    },
    /** Count one hit; returns the seconds to wait if this hit went over the limit, else 0. */
    hit(key) {
      if (!limit) return 0;
      const e = entry(key);
      return ++e.n > limit ? Math.ceil((e.reset - Date.now()) / 1000) : 0;
    },
  };
}
