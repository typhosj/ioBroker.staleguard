/** What one check does with one watch: status change, notifications, restart. Pure; time is passed in. */

import { lastSign, type Observed, type Status } from './evaluate';
import { exhaustedText, missingText, recoveredText, staleText, type Lang } from './messages';
import { afterExhausted, afterRestart, decideRestart, emptyRestart, type RestartRuntime } from './restart';
import type { Watch } from './watchlist';

export type Category = 'stale' | 'recovered' | 'configError';

/** One notification line. */
export interface Note {
    /** Notification category. */
    category: Category;
    /** Finished text in the system language. */
    text: string;
}

/** In-memory state of one watch. */
export interface WatchRuntime {
    /** Display name of the watched object. */
    name: string;
    /** Current status. */
    status: Status;
    /** Time of the last status change. */
    since: number;
    /** Restart bookkeeping of the current outage. */
    restart: RestartRuntime;
}

/** Everything one step depends on. */
export interface StepInput {
    /** The watch. */
    watch: Watch;
    /** Runtime before this check. */
    rt: WatchRuntime;
    /** Status evaluated in this check. */
    status: Status;
    /** Timestamps of the watched state, null when it has no state. */
    observed: Observed | null;
    /** Current time in ms. */
    now: number;
    /** `common.enabled` of the owning instance; only read when a restart is due. */
    instanceEnabled: boolean;
    /** Last restart of the owning instance by any watch. */
    lastInstanceRestart: number | undefined;
    /** Minimum gap between two restarts of one instance in ms. */
    lockMs: number;
    /** Notification language. */
    lang: Lang;
    /** Deadline or mode changed since the last check; an ok that follows is no recovery. */
    settingsChanged: boolean;
}

const MINUTE_MS = 60_000;

/**
 * True when a restart decision is possible, so the caller only reads the instance object then.
 *
 * @param watch the watch
 * @param rt runtime before this check
 * @param status status evaluated in this check
 */
export function restartPossible(watch: Watch, rt: WatchRuntime, status: Status): boolean {
    return status === 'stale' && watch.owner !== null && watch.restartAttempts > 0 && !rt.restart.gaveUp;
}

/**
 * Applies one check result. Only transitions cause notifications; `missing` → `ok` is a first
 * value, not a recovery, and stays silent, as does `stale` → `ok` caused by changed settings.
 *
 * @param input watch, runtime, status and time
 */
export function step(input: StepInput): { rt: WatchRuntime; notes: Note[]; restart: string | null } {
    const { watch, status, observed, now, lang } = input;
    const before = input.rt;
    const changed = status !== before.status;
    const rt: WatchRuntime = changed
        ? { ...before, status, since: now, restart: status === 'stale' ? before.restart : emptyRestart() }
        : { ...before };
    const notes: Note[] = [];

    let restart: string | null = null;
    if (watch.owner && restartPossible(watch, rt, status)) {
        const decision = decideRestart({
            status,
            owner: watch.owner,
            attemptsAllowed: watch.restartAttempts,
            timeoutMs: watch.timeoutMs,
            runtime: rt.restart,
            instanceEnabled: input.instanceEnabled,
            lastInstanceRestart: input.lastInstanceRestart,
            lockMs: input.lockMs,
            now,
        });
        if (decision === 'restart') {
            rt.restart = afterRestart(rt.restart, now);
            restart = watch.owner;
        } else if (decision === 'exhausted') {
            rt.restart = afterExhausted(rt.restart);
            notes.push({
                category: 'stale',
                text: exhaustedText(lang, rt.name, watch.id, rt.restart.attempts, watch.owner),
            });
        }
    }

    if (changed) {
        if (status === 'stale' && observed) {
            const minutes = Math.round((now - lastSign(watch, observed)) / MINUTE_MS);
            notes.push({ category: 'stale', text: staleText(lang, rt.name, watch.id, minutes, restart) });
        } else if (status === 'ok' && before.status === 'stale' && !input.settingsChanged) {
            notes.push({ category: 'recovered', text: recoveredText(lang, rt.name, watch.id) });
        } else if (status === 'missing') {
            notes.push({ category: 'configError', text: missingText(lang, watch.id) });
        }
    }
    return { rt, notes, restart };
}

/**
 * Runtime of a watch rebuilt from its own states after a Staleguard restart. The last restart is
 * assumed at `startTime`, so the next attempt waits one full deadline. The give-up flag is not
 * stored, so the give-up notification can come once more after a Staleguard restart instead of
 * never.
 *
 * @param name display name
 * @param status stored status, or null
 * @param since stored time of the last status change, or null
 * @param attempts stored restart attempts
 * @param startTime start of this Staleguard run
 */
export function restoreRuntime(
    name: string,
    status: Status | null,
    since: number | null,
    attempts: number,
    startTime: number,
): WatchRuntime {
    return {
        name,
        status: status ?? 'ok',
        since: since ?? startTime,
        restart: { attempts, lastRestartAt: attempts > 0 ? startTime : null, gaveUp: false },
    };
}
