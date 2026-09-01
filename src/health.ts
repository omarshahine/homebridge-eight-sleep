export class PollHealth {
  private readonly staleMs: number;
  private readonly now: () => number;
  private lastGood: number;
  private online = true;
  private failures = 0;

  constructor(opts: { staleMs?: number; now?: () => number } = {}) {
    this.staleMs = opts.staleMs ?? 5 * 60_000;
    this.now = opts.now ?? Date.now;
    // Grace period: treat startup as "just polled" so tiles don't show No Response before the first poll.
    this.lastGood = this.now();
  }

  recordSuccess(online: boolean): void {
    this.lastGood = this.now();
    this.online = online;
    this.failures = 0;
  }

  recordFailure(): void {
    this.failures += 1;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }

  get healthy(): boolean {
    return this.online && (this.now() - this.lastGood) <= this.staleMs;
  }
}
