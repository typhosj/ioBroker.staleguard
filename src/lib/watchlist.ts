/** Validation of the per-state custom settings and the instance settings. No ioBroker API here. */

export type Mode = 'update' | 'change';

/** One validated watch. `owner` is the instance a restart would target, or null. */
export interface Watch {
    /** Watched state id. */
    id: string;
    /** Own channel id below `watches.`. */
    sid: string;
    /** Deadline in ms. */
    timeoutMs: number;
    /** Which timestamp counts as a sign of life. */
    mode: Mode;
    /** Instance restarts per outage, 0 = off. */
    restartAttempts: number;
    /** Instance a restart would target, or null. */
    owner: string | null;
}

/** A custom entry that could not be turned into a watch. */
export interface WatchError {
    /** Watched state id. */
    id: string;
    /** Why the entry was rejected, in English. */
    reason: string;
}

export const MAX_WATCHES = 5000;

const MINUTE_MS = 60_000;
const NOT_RESTARTABLE = new Set(['system', 'alias', '0_userdata']);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIntIn(value: unknown, min: number, max: number): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Own channel id for a watched state: one flat level, so no parent channels are needed.
 *
 * @param id watched state id
 * @param forbidden the adapter's FORBIDDEN_CHARS pattern
 */
export function toSid(id: string, forbidden: RegExp): string {
    return id.replace(forbidden, '_').replaceAll('.', '__');
}

/**
 * The adapter instance that owns a state, or null when a restart makes no sense.
 *
 * @param id watched state id
 * @param ownNamespace Staleguard's own namespace, e.g. `staleguard.0`
 */
export function ownerInstance(id: string, ownNamespace: string): string | null {
    const match = /^([a-z0-9_-]+)\.(\d+)\./.exec(id);
    if (!match || NOT_RESTARTABLE.has(match[1])) {
        return null;
    }
    const instance = `${match[1]}.${match[2]}`;
    return instance === ownNamespace ? null : instance;
}

/**
 * Turns one custom entry into a watch. Missing keys take their default; present but invalid
 * values are rejected, never replaced.
 *
 * @param id watched state id
 * @param raw the `common.custom['staleguard.<n>']` entry
 * @param ownNamespace Staleguard's own namespace
 * @param forbidden the adapter's FORBIDDEN_CHARS pattern
 */
export function parseCustom(
    id: string,
    raw: unknown,
    ownNamespace: string,
    forbidden: RegExp,
): { watch: Watch } | { error: WatchError } | null {
    if (!isRecord(raw) || raw.enabled !== true) {
        return null;
    }
    const error = (reason: string): { error: WatchError } => ({ error: { id, reason } });
    if (id.startsWith(`${ownNamespace}.`)) {
        return error('Staleguard cannot watch its own states');
    }
    const timeoutMin = raw.timeoutMin ?? 60;
    if (!isIntIn(timeoutMin, 1, 10080)) {
        return error(`deadline must be a whole number of minutes from 1 to 10080, got ${JSON.stringify(timeoutMin)}`);
    }
    const mode = raw.mode ?? 'update';
    if (mode !== 'update' && mode !== 'change') {
        return error(`mode must be "update" or "change", got ${JSON.stringify(mode)}`);
    }
    const restartAttempts = raw.restartAttempts ?? 0;
    if (!isIntIn(restartAttempts, 0, 5)) {
        return error(`restart attempts must be a whole number from 0 to 5, got ${JSON.stringify(restartAttempts)}`);
    }
    const owner = ownerInstance(id, ownNamespace);
    if (restartAttempts > 0 && owner === null) {
        return error('instance restarts are only possible for states of another adapter instance');
    }
    return {
        watch: { id, sid: toSid(id, forbidden), timeoutMs: timeoutMin * MINUTE_MS, mode, restartAttempts, owner },
    };
}

/**
 * Validates all custom entries. Sorted by id, so collisions and the cap resolve the same way on
 * every start.
 *
 * @param entries watched ids with their raw custom entry
 * @param ownNamespace Staleguard's own namespace
 * @param forbidden the adapter's FORBIDDEN_CHARS pattern
 * @param max maximum number of watches
 */
export function buildWatchlist(
    entries: { id: string; custom: unknown }[],
    ownNamespace: string,
    forbidden: RegExp,
    max = MAX_WATCHES,
): { watches: Watch[]; errors: WatchError[] } {
    const watches: Watch[] = [];
    const errors: WatchError[] = [];
    const sids = new Map<string, string>();
    for (const entry of [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
        const result = parseCustom(entry.id, entry.custom, ownNamespace, forbidden);
        if (result === null) {
            continue;
        }
        if ('error' in result) {
            errors.push(result.error);
            continue;
        }
        const taken = sids.get(result.watch.sid);
        if (taken !== undefined) {
            errors.push({ id: entry.id, reason: `its channel id collides with the watch of ${taken}` });
            continue;
        }
        if (watches.length >= max) {
            errors.push({ id: entry.id, reason: `more than ${max} watched states, this one is ignored` });
            continue;
        }
        sids.set(result.watch.sid, entry.id);
        watches.push(result.watch);
    }
    return { watches, errors };
}

function clampSetting(
    name: string,
    value: unknown,
    min: number,
    max: number,
    fallback: number,
    warnings: string[],
): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        warnings.push(`Setting ${name} is not a number (${JSON.stringify(value)}), using ${fallback}.`);
        return fallback;
    }
    const clamped = Math.min(max, Math.max(min, Math.round(value)));
    if (clamped !== value) {
        warnings.push(`Setting ${name} = ${value} is outside ${min}–${max}, using ${clamped}.`);
    }
    return clamped;
}

/**
 * Validates and clamps the instance settings; the admin limits are convenience only.
 *
 * @param native the instance's native settings
 * @param native.checkIntervalSec check interval in seconds
 * @param native.restartLockMin minimum gap between two restarts of one instance in minutes
 */
export function normalizeNative(native: { checkIntervalSec?: unknown; restartLockMin?: unknown }): {
    checkIntervalSec: number;
    restartLockMin: number;
    warnings: string[];
} {
    const warnings: string[] = [];
    return {
        checkIntervalSec: clampSetting('checkIntervalSec', native.checkIntervalSec, 10, 600, 60, warnings),
        restartLockMin: clampSetting('restartLockMin', native.restartLockMin, 10, 1440, 60, warnings),
        warnings,
    };
}
