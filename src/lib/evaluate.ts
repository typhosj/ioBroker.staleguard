/** Status of one watch at one moment. Pure; time is passed in. */

import type { Watch } from './watchlist';

export type Status = 'ok' | 'stale' | 'missing';

/** The two timestamps of an ioBroker state that count as a sign of life. */
export interface Observed {
    /** Time of the last write. */
    ts: number;
    /** Time of the last value change. */
    lc: number;
}

const STATUSES: readonly string[] = ['ok', 'stale', 'missing'];

/**
 * True for the three status strings this adapter writes.
 *
 * @param value value read back from an own state
 */
export function isStatus(value: unknown): value is Status {
    return typeof value === 'string' && STATUSES.includes(value);
}

/**
 * The timestamp that counts as the last sign of life for this watch.
 *
 * @param watch the watch, only its mode is read
 * @param observed timestamps of the watched state
 */
export function lastSign(watch: Pick<Watch, 'mode'>, observed: Observed): number {
    return watch.mode === 'update' ? observed.ts : observed.lc;
}

/**
 * Status of one watch. The deadline runs from the later of the last sign of life and
 * `graceStart`, so states that were old before Staleguard started get the full deadline first.
 * Pass 0 as `graceStart` to evaluate the raw timestamp.
 *
 * Known limit: a timestamp in the future (clock moved back) keeps the watch `ok` until the clock
 * catches up.
 *
 * @param watch mode and deadline
 * @param observed timestamps of the watched state, null when it has no state
 * @param now current time in ms
 * @param graceStart start of the grace period in ms, or 0
 */
export function statusOf(
    watch: Pick<Watch, 'mode' | 'timeoutMs'>,
    observed: Observed | null,
    now: number,
    graceStart: number,
): Status {
    if (!observed) {
        return 'missing';
    }
    const sign = lastSign(watch, observed);
    if (!Number.isFinite(sign)) {
        return 'missing';
    }
    return now - Math.max(sign, graceStart) > watch.timeoutMs ? 'stale' : 'ok';
}
