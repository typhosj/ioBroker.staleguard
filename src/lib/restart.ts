/** When to restart the instance that owns a stale state. Pure; time is passed in. */

import type { Status } from './evaluate';

/** Restart bookkeeping of one watch during one outage. */
export interface RestartRuntime {
    /** Restarts triggered in this outage. */
    attempts: number;
    /** Time of the last restart, or null. */
    lastRestartAt: number | null;
    /** True once the give-up notification was sent. */
    gaveUp: boolean;
}

export type RestartDecision = 'restart' | 'exhausted' | 'none';

/** Everything one restart decision depends on. */
export interface RestartInput {
    /** Current status of the watch. */
    status: Status;
    /** Instance a restart would target, or null. */
    owner: string | null;
    /** Configured restarts per outage. */
    attemptsAllowed: number;
    /** Deadline of the watch in ms; also the gap between two attempts. */
    timeoutMs: number;
    /** Bookkeeping of this outage. */
    runtime: RestartRuntime;
    /** `common.enabled` of the owning instance. */
    instanceEnabled: boolean;
    /** Last restart of the owning instance by any watch, for the per-instance lock. */
    lastInstanceRestart: number | undefined;
    /** Minimum gap between two restarts of one instance in ms. */
    lockMs: number;
    /** Current time in ms. */
    now: number;
}

/** Bookkeeping for a watch that is not in an outage. */
export function emptyRestart(): RestartRuntime {
    return { attempts: 0, lastRestartAt: null, gaveUp: false };
}

/**
 * Decides what to do for one stale watch in this cycle.
 *
 * - The first attempt comes as soon as the state is stale; each further attempt one full deadline
 *   after the previous restart.
 * - After the last attempt and one more deadline, `exhausted` comes exactly once.
 * - A disabled instance is never restarted, and the per-instance lock limits restarts caused by
 *   several watches of the same instance.
 *
 * @param input current watch, instance and time
 */
export function decideRestart(input: RestartInput): RestartDecision {
    const { runtime } = input;
    if (input.status !== 'stale' || input.owner === null || input.attemptsAllowed === 0 || runtime.gaveUp) {
        return 'none';
    }
    if (runtime.lastRestartAt !== null && input.now - runtime.lastRestartAt < input.timeoutMs) {
        return 'none';
    }
    if (runtime.attempts >= input.attemptsAllowed) {
        return 'exhausted';
    }
    if (!input.instanceEnabled) {
        return 'none';
    }
    if (input.lastInstanceRestart !== undefined && input.now - input.lastInstanceRestart < input.lockMs) {
        return 'none';
    }
    return 'restart';
}

/**
 * Bookkeeping after a restart was triggered. A failed restart counts too, so it cannot loop.
 *
 * @param runtime bookkeeping before the restart
 * @param now time of the restart
 */
export function afterRestart(runtime: RestartRuntime, now: number): RestartRuntime {
    return { attempts: runtime.attempts + 1, lastRestartAt: now, gaveUp: false };
}

/**
 * Bookkeeping after the give-up notification.
 *
 * @param runtime bookkeeping before
 */
export function afterExhausted(runtime: RestartRuntime): RestartRuntime {
    return { ...runtime, gaveUp: true };
}
