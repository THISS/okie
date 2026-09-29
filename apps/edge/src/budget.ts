import { DurableObject } from 'cloudflare:workers';
import type { EdgeEnv } from './env';

/**
 * Durable daily budget for the paid routes (CLA-266). ONE instance (`getByName("global")`), SQLite-backed,
 * counters per UTC day:
 *
 *   - requests per bucket (`ask`, `block-plan`), refused past the bucket's daily max;
 *   - an Ask dollar ledger: admission reserves an estimate and is refused when
 *     reserved + spent + estimate would exceed the daily dollar cap; once the container answers, the
 *     reservation settles to the real cost (`x-okie-ask-cost-usd`) or keeps the estimate.
 *
 * A reservation whose settle never arrives (isolate died mid-request) stays counted — fail closed.
 * All methods are synchronous SQL inside one Durable Object, so admission is atomic.
 */

export type BudgetBucket = 'ask' | 'block-plan';

export type AdmitInput = {
  bucket: BudgetBucket;
  /** UTC day `YYYY-MM-DD` (computed by the caller so tests control time). */
  day: string;
  maxRequests: number;
  /** Ask only: dollars reserved at admission and the day's dollar cap. */
  dollars?: { estimate: number; max: number };
};

export type AdmitResult =
  | { ok: true; reservationId?: string }
  | { ok: false; reason: 'requests' | 'dollars' };

export type DayUsage = {
  day: string;
  requests: Record<BudgetBucket, number>;
  reservedDollars: number;
  spentDollars: number;
  openReservations: number;
};

const KEEP_DAYS = 14;

function dayMinus(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

export class AtlasBudget extends DurableObject<EdgeEnv> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: EdgeEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS request_counts (day TEXT NOT NULL, bucket TEXT NOT NULL, requests INTEGER NOT NULL, PRIMARY KEY (day, bucket))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS dollar_spent (day TEXT PRIMARY KEY, spent REAL NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS dollar_reservations (id TEXT PRIMARY KEY, day TEXT NOT NULL, amount REAL NOT NULL)`);
  }

  private requests(day: string, bucket: BudgetBucket): number {
    return (this.sql.exec<{ requests: number }>('SELECT requests FROM request_counts WHERE day = ? AND bucket = ?', day, bucket).toArray()[0]?.requests) ?? 0;
  }

  private spent(day: string): number {
    return (this.sql.exec<{ spent: number }>('SELECT spent FROM dollar_spent WHERE day = ?', day).toArray()[0]?.spent) ?? 0;
  }

  private reserved(day: string): { amount: number; count: number } {
    const row = this.sql.exec<{ amount: number | null; count: number }>('SELECT SUM(amount) AS amount, COUNT(*) AS count FROM dollar_reservations WHERE day = ?', day).toArray()[0];
    return { amount: row?.amount ?? 0, count: row?.count ?? 0 };
  }

  admit(input: AdmitInput): AdmitResult {
    const cutoff = dayMinus(input.day, KEEP_DAYS);
    this.sql.exec('DELETE FROM request_counts WHERE day < ?', cutoff);
    this.sql.exec('DELETE FROM dollar_spent WHERE day < ?', cutoff);
    this.sql.exec('DELETE FROM dollar_reservations WHERE day < ?', cutoff);

    if (this.requests(input.day, input.bucket) + 1 > input.maxRequests) return { ok: false, reason: 'requests' };
    let reservationId: string | undefined;
    if (input.dollars) {
      const committed = this.reserved(input.day).amount + this.spent(input.day);
      if (committed + input.dollars.estimate > input.dollars.max + 1e-9) return { ok: false, reason: 'dollars' };
      reservationId = crypto.randomUUID();
      this.sql.exec('INSERT INTO dollar_reservations (id, day, amount) VALUES (?, ?, ?)', reservationId, input.day, input.dollars.estimate);
    }
    this.sql.exec(
      'INSERT INTO request_counts (day, bucket, requests) VALUES (?, ?, 1) ON CONFLICT (day, bucket) DO UPDATE SET requests = requests + 1',
      input.day,
      input.bucket,
    );
    return reservationId ? { ok: true, reservationId } : { ok: true };
  }

  /** Close a reservation at the real cost (`undefined`/invalid → keep the estimate). Unknown ids are ignored. */
  settle(reservationId: string, actualDollars?: number): void {
    const row = this.sql.exec<{ day: string; amount: number }>('SELECT day, amount FROM dollar_reservations WHERE id = ?', reservationId).toArray()[0];
    if (!row) return;
    const amount = typeof actualDollars === 'number' && Number.isFinite(actualDollars) && actualDollars >= 0 ? actualDollars : row.amount;
    this.sql.exec('DELETE FROM dollar_reservations WHERE id = ?', reservationId);
    this.sql.exec(
      'INSERT INTO dollar_spent (day, spent) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET spent = spent + excluded.spent',
      row.day,
      amount,
    );
  }

  usage(day: string): DayUsage {
    const reserved = this.reserved(day);
    return {
      day,
      requests: { ask: this.requests(day, 'ask'), 'block-plan': this.requests(day, 'block-plan') },
      reservedDollars: reserved.amount,
      spentDollars: this.spent(day),
      openReservations: reserved.count,
    };
  }
}
