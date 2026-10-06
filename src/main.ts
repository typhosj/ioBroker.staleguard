/*
 * Created with @iobroker/create-adapter
 */

import * as utils from '@iobroker/adapter-core';

import { isStatus, lastSign, statusOf, type Observed, type Status } from './lib/evaluate';
import {
    displayName,
    exhaustedText,
    invalidText,
    missingText,
    pickLang,
    recoveredText,
    restartFailedText,
    staleText,
    type Lang,
} from './lib/messages';
import { afterExhausted, afterRestart, decideRestart, emptyRestart, type RestartRuntime } from './lib/restart';
import { buildWatchlist, normalizeNative, type Watch } from './lib/watchlist';

declare global {
    // ioBroker declares notification scopes as an interface for adapters to extend.
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace ioBroker {
        interface NotificationScopes {
            staleguard: 'stale' | 'recovered' | 'configError';
        }
    }
}

type Category = 'stale' | 'recovered' | 'configError';

const MINUTE_MS = 60_000;
/** Custom settings are often saved field by field; collect them before reloading. */
const RELOAD_DEBOUNCE_MS = 2_000;

/** In-memory state of one watch. Restored from the own states after a Staleguard restart. */
interface WatchRuntime {
    name: string;
    status: Status;
    since: number;
    restart: RestartRuntime;
}

const WATCH_STATES: { id: string; name: string; type: ioBroker.CommonType; role: string }[] = [
    { id: 'stale', name: 'Silent', type: 'boolean', role: 'indicator.alarm' },
    { id: 'status', name: 'Status (ok, stale, missing)', type: 'string', role: 'text' },
    { id: 'since', name: 'Status since', type: 'number', role: 'value.time' },
    { id: 'restarts', name: 'Restarts in this outage', type: 'number', role: 'value' },
];

function errText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

class Staleguard extends utils.Adapter {
    private watches = new Map<string, Watch>();
    private runtime = new Map<string, WatchRuntime>();
    private instanceRestarts = new Map<string, number>();
    private reportedErrors = new Set<string>();
    private cycleTimer: ioBroker.Timeout | undefined;
    private reloadTimer: ioBroker.Timeout | undefined;
    private queue: Promise<void> = Promise.resolve();
    private stopping = false;
    private loadFailed = false;
    private readFailed = false;
    private startTime = 0;
    private lang: Lang = 'en';
    private intervalMs = 60_000;
    private lockMs = 60 * MINUTE_MS;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'staleguard' });
        this.on('ready', this.onReady.bind(this));
        this.on('objectChange', this.onObjectChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        this.startTime = Date.now();
        const settings = normalizeNative(this.config);
        for (const warning of settings.warnings) {
            this.log.warn(warning);
        }
        this.intervalMs = settings.checkIntervalSec * 1000;
        this.lockMs = settings.restartLockMin * MINUTE_MS;
        try {
            const systemConfig = await this.getForeignObjectAsync('system.config');
            this.lang = pickLang(systemConfig?.common?.language);
        } catch (error) {
            this.log.warn(`Cannot read the system language: ${errText(error)}. Notifications are written in English.`);
        }
        await this.serial(() => this.loadWatches());
        await this.subscribeForeignObjectsAsync('*');
        await this.runCycle();
    }

    /**
     * Runs tasks one after another, so a reload never interleaves with a check.
     *
     * @param task work to queue
     */
    private serial(task: () => Promise<void>): Promise<void> {
        const run = this.queue.then(task);
        this.queue = run.catch(() => undefined);
        return run;
    }

    private async runCycle(): Promise<void> {
        try {
            await this.serial(async () => {
                if (this.loadFailed) {
                    await this.loadWatches();
                }
                await this.checkAll();
            });
        } catch (error) {
            this.log.error(`Check failed: ${errText(error)}. Next check in ${this.intervalMs / 1000} s.`);
        }
        if (!this.stopping) {
            this.cycleTimer = this.setTimeout(() => void this.runCycle(), this.intervalMs);
        }
    }

    private async loadWatches(): Promise<void> {
        try {
            await this.reloadWatches();
            this.loadFailed = false;
        } catch (error) {
            this.loadFailed = true;
            this.log.error(`Cannot read the watch list: ${errText(error)}. Retrying with the next check.`);
        }
    }

    private async reloadWatches(): Promise<void> {
        const view = await this.getObjectViewAsync('system', 'custom', {});
        const entries = view.rows.map(row => ({
            id: row.id,
            custom: (row.value as Record<string, unknown> | null | undefined)?.[this.namespace],
        }));
        const { watches, errors } = buildWatchlist(entries, this.namespace, this.FORBIDDEN_CHARS);
        for (const error of errors) {
            const key = `${error.id}|${error.reason}`;
            if (!this.reportedErrors.has(key)) {
                this.reportedErrors.add(key);
                await this.notify('configError', invalidText(this.lang, error.id, error.reason));
            }
        }
        const next = new Map(watches.map(watch => [watch.id, watch]));
        for (const id of this.runtime.keys()) {
            if (!next.has(id)) {
                this.runtime.delete(id);
            }
        }
        this.watches = next;
        for (const watch of watches) {
            if (!this.runtime.has(watch.id)) {
                await this.addWatch(watch);
            }
        }
        await this.sweepOrphans();
        this.log.info(`Watching ${watches.length} state(s).`);
    }

    private async addWatch(watch: Watch): Promise<void> {
        const source = await this.getForeignObjectAsync(watch.id);
        const name = displayName(source?.common?.name, this.lang, watch.id);
        const base = `watches.${watch.sid}`;
        await this.setObjectNotExistsAsync(base, {
            type: 'channel',
            common: { name: `${name} (${watch.id})` },
            native: { sourceId: watch.id },
        });
        for (const def of WATCH_STATES) {
            await this.setObjectNotExistsAsync(`${base}.${def.id}`, {
                type: 'state',
                common: { name: def.name, type: def.type, role: def.role, read: true, write: false },
                native: {},
            });
        }
        const [status, since, restarts] = await Promise.all([
            this.getStateAsync(`${base}.status`),
            this.getStateAsync(`${base}.since`),
            this.getStateAsync(`${base}.restarts`),
        ]);
        const attempts = typeof restarts?.val === 'number' ? restarts.val : 0;
        this.runtime.set(watch.id, {
            name,
            status: isStatus(status?.val) ? status.val : 'ok',
            since: typeof since?.val === 'number' ? since.val : Date.now(),
            restart: {
                attempts,
                lastRestartAt: attempts > 0 ? this.startTime : null,
                gaveUp: attempts > 0 && attempts >= watch.restartAttempts,
            },
        });
    }

    /** Deletes watch channels whose state is no longer watched. Only channels carrying our sourceId. */
    private async sweepOrphans(): Promise<void> {
        const prefix = `${this.namespace}.watches.`;
        const view = await this.getObjectViewAsync('system', 'channel', { startkey: prefix, endkey: `${prefix}香` });
        for (const row of view.rows) {
            const sourceId: unknown = row.value?.native?.sourceId;
            if (typeof sourceId !== 'string') {
                continue;
            }
            const watch = this.watches.get(sourceId);
            if (watch && row.id === `${prefix}${watch.sid}`) {
                continue;
            }
            await this.delForeignObjectAsync(row.id, { recursive: true });
            this.log.info(`Removed the watch channel of ${sourceId}.`);
        }
    }

    private async checkAll(): Promise<void> {
        const ids = [...this.watches.keys()];
        let states: Record<string, ioBroker.State | null | undefined> = {};
        if (ids.length > 0) {
            try {
                states = await this.getForeignStatesAsync(ids);
            } catch (error) {
                if (!this.readFailed) {
                    this.readFailed = true;
                    this.log.warn(
                        `Cannot read the watched states: ${errText(error)}. Checks are skipped, no alarm is raised.`,
                    );
                }
                return;
            }
            if (this.readFailed) {
                this.readFailed = false;
                this.log.info('Reading the watched states works again.');
            }
        }
        const now = Date.now();
        for (const watch of this.watches.values()) {
            const state = states[watch.id];
            await this.applyStatus(watch, state ? { ts: state.ts, lc: state.lc } : null, now);
        }
        await this.writeSummary();
    }

    private async applyStatus(watch: Watch, observed: Observed | null, now: number): Promise<void> {
        const rt = this.runtime.get(watch.id);
        if (!rt) {
            return;
        }
        // A watch that was stale before a restart is judged by its raw timestamp, or the grace
        // would report a false recovery on the first cycle.
        const status = statusOf(watch, observed, now, rt.status === 'stale' ? 0 : this.startTime);
        const changed = status !== rt.status;
        if (changed) {
            rt.status = status;
            rt.since = now;
            if (status !== 'stale') {
                rt.restart = emptyRestart();
            }
        }

        let restarting: string | null = null;
        if (status === 'stale' && watch.owner && watch.restartAttempts > 0 && !rt.restart.gaveUp) {
            const decision = decideRestart({
                status,
                owner: watch.owner,
                attemptsAllowed: watch.restartAttempts,
                timeoutMs: watch.timeoutMs,
                runtime: rt.restart,
                instanceEnabled: await this.instanceEnabled(watch.owner),
                lastInstanceRestart: this.instanceRestarts.get(watch.owner),
                lockMs: this.lockMs,
                now,
            });
            if (decision === 'restart') {
                rt.restart = afterRestart(rt.restart, now);
                this.instanceRestarts.set(watch.owner, now);
                restarting = watch.owner;
            } else if (decision === 'exhausted') {
                rt.restart = afterExhausted(rt.restart);
                await this.notify(
                    'stale',
                    exhaustedText(this.lang, rt.name, watch.id, rt.restart.attempts, watch.owner),
                );
            }
        }

        if (changed) {
            if (status === 'stale' && observed) {
                const minutes = Math.round((now - lastSign(watch, observed)) / MINUTE_MS);
                await this.notify('stale', staleText(this.lang, rt.name, watch.id, minutes, restarting));
            } else if (status === 'ok') {
                await this.notify('recovered', recoveredText(this.lang, rt.name, watch.id));
            } else if (status === 'missing') {
                await this.notify('configError', missingText(this.lang, watch.id));
            }
        }

        if (restarting) {
            if (!changed) {
                this.log.info(
                    `Restarting ${restarting} again (attempt ${rt.restart.attempts} of ${watch.restartAttempts}), ${watch.id} is still silent.`,
                );
            }
            try {
                await this.extendForeignObjectAsync(`system.adapter.${restarting}`, { common: { enabled: true } });
            } catch (error) {
                await this.notify('configError', restartFailedText(this.lang, restarting, errText(error)));
            }
        }

        const base = `watches.${watch.sid}`;
        await this.setStateChangedAsync(`${base}.stale`, rt.status === 'stale', true);
        await this.setStateChangedAsync(`${base}.status`, rt.status, true);
        await this.setStateChangedAsync(`${base}.since`, rt.since, true);
        await this.setStateChangedAsync(`${base}.restarts`, rt.restart.attempts, true);
    }

    private async instanceEnabled(instance: string): Promise<boolean> {
        // A plain string id types the result as any object, so the type check below narrows.
        const obj = await this.getForeignObjectAsync<string>(`system.adapter.${instance}`);
        return obj?.type === 'instance' && obj.common.enabled === true;
    }

    private async writeSummary(): Promise<void> {
        const list = [...this.watches.values()].map(watch => {
            const rt = this.runtime.get(watch.id);
            return { id: watch.id, name: rt?.name ?? watch.id, status: rt?.status ?? 'ok', since: rt?.since ?? null };
        });
        await this.setStateChangedAsync('summary.watched', list.length, true);
        await this.setStateChangedAsync('summary.stale', list.filter(entry => entry.status === 'stale').length, true);
        await this.setStateChangedAsync('summary.list', JSON.stringify(list), true);
    }

    private async notify(category: Category, text: string): Promise<void> {
        if (category === 'recovered') {
            this.log.info(text);
        } else {
            this.log.warn(text);
        }
        try {
            await this.registerNotification('staleguard', category, text);
        } catch (error) {
            this.log.warn(`Cannot raise the notification: ${errText(error)}`);
        }
    }

    private onObjectChange(id: string, obj: ioBroker.Object | null | undefined): void {
        // A deleted object keeps its watch, which then reports `missing`.
        if (this.stopping || !obj || id.startsWith(`${this.namespace}.`)) {
            return;
        }
        const custom = (obj.common as { custom?: Record<string, unknown> } | undefined)?.custom;
        if (custom?.[this.namespace] === undefined && !this.watches.has(id)) {
            return;
        }
        if (this.reloadTimer) {
            this.clearTimeout(this.reloadTimer);
        }
        this.reloadTimer = this.setTimeout(() => {
            this.reloadTimer = undefined;
            void this.serial(() => this.loadWatches());
        }, RELOAD_DEBOUNCE_MS);
    }

    private onUnload(callback: () => void): void {
        try {
            this.stopping = true;
            if (this.cycleTimer) {
                this.clearTimeout(this.cycleTimer);
            }
            if (this.reloadTimer) {
                this.clearTimeout(this.reloadTimer);
            }
        } finally {
            callback();
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Staleguard(options);
} else {
    // otherwise start the instance directly
    (() => new Staleguard())();
}
