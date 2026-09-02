export interface RateLimiter {
  check(key: string): boolean;
  sweep(): void;
}

export interface RateLimiterOptions {
  limit?: number;
  windowMs?: number;
  now?: () => number;
}

export function createRateLimiter({
  limit = 30,
  windowMs = 60_000,
  now = Date.now,
}: RateLimiterOptions = {}): RateLimiter {
  const hits = new Map<string, number[]>();

  return {
    check(key: string) {
      const at = now();
      const cutoff = at - windowMs;
      const recent = (hits.get(key) ?? []).filter((ts) => ts > cutoff);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(at);
      hits.set(key, recent);
      return true;
    },

    sweep() {
      const cutoff = now() - windowMs;
      for (const [key, times] of hits) {
        const recent = times.filter((ts) => ts > cutoff);
        if (recent.length === 0) hits.delete(key);
        else hits.set(key, recent);
      }
    },
  };
}
