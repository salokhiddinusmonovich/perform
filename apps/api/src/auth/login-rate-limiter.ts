import { Injectable } from '@nestjs/common';

const WINDOW_MS = 15 * 60 * 1000;
/** Failed attempts allowed per login name (phone/email) within the window. */
const MAX_PER_IDENTIFIER = 5;
/** Failed attempts allowed per IP address within the window (covers guessing many logins). */
const MAX_PER_IP = 30;

/**
 * Slows down password guessing. Kept in memory: the API runs as a single process
 * (compose.yaml). If it ever runs as several processes, move this to the database.
 */
@Injectable()
export class LoginRateLimiter {
  private readonly failures = new Map<string, number[]>();

  /** Seconds to wait before another attempt is allowed, or 0 if allowed now. */
  retryAfterSeconds(identifier: string, ip: string): number {
    const now = Date.now();
    let wait = 0;
    for (const [key, max] of [
      [`id:${identifier}`, MAX_PER_IDENTIFIER],
      [`ip:${ip}`, MAX_PER_IP],
    ] as const) {
      const recent = this.recent(key, now);
      if (recent.length >= max) wait = Math.max(wait, Math.ceil((recent[0] + WINDOW_MS - now) / 1000));
    }
    return wait;
  }

  recordFailure(identifier: string, ip: string) {
    const now = Date.now();
    for (const key of [`id:${identifier}`, `ip:${ip}`]) {
      this.failures.set(key, [...this.recent(key, now), now]);
    }
  }

  /** A successful login clears that login name's failures (not the IP's). */
  recordSuccess(identifier: string) {
    this.failures.delete(`id:${identifier}`);
  }

  private recent(key: string, now: number): number[] {
    const list = (this.failures.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }
}
