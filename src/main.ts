import * as utils from '@iobroker/adapter-core';

import { isStatus, statusOf, type Observed } from './lib/evaluate';
import { displayName, invalidText, joinLines, pickLang, restartFailedText, type Lang } from './lib/messages';
import { restartPossible, restoreRuntime, step, type Category, type Note, type WatchRuntime } from './lib/transition';
import { buildWatchlist, freshErrors, normalizeNative, type Watch } from './lib/watchlist';

declare global {
    // ioBroker declares notification scopes as an interface for adapters to extend.
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace ioBroker {
        interface NotificationScopes {
            staleguard: 'stale' | 'recovered' | 'configError';
        }
    }
}

const MINUTE_MS = 60_000;
/** Custom settings are often saved field by field; collect them before reloading. */
const RELOAD_DEBOUNCE_MS = 2_000;
const CATEGORIES: readonly Category[] = ['stale', 'recovered', 'configError'];

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
    /** Own channel id → watched state id. */
    private sids = new Map<string, string>();
    private runtime = new Map<string, WatchRuntime>();
    /** Last values written to the own states of a watch, so unchanged watches cost no DB access. */
    private written = new Map<string, string>();
    private instanceRestarts = new Map<string, number>();
    private reportedErrors = new Set<string>();
    /** Watches whose own objects were deleted from outside and are recreated on the next reload. */
    private recreate = new Set<string>();
    private notes: Note[] = [];
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
     * Runs tasks one after another, so a reload never interleaves with a check. Nothing runs once
     * the adapter is stopping.
     *
     * @param task work to queue
     */
    private serial(task: () => Promise<void>): Promise<void> {
        const run = this.queue.then(() => (this.stopping ? undefined : task()));
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
        await this.flushNotes();
    }

    private async reloadWatches(): Promise<void> {
        const view = await this.getObjectViewAsync('system', 'custom', {});
        const entries = view.rows.map(row => ({
            id: row.id,
            custom: (row.value as Record<string, unknown> | null | undefined)?.[this.namespace],
        }));
        const { watches, errors } = buildWatchlist(entries, this.namespace, this.FORBIDDEN_CHARS);
        const { fresh, reported } = freshErrors(errors, this.reportedErrors);
        this.reportedErrors = reported;
        for (const error of fresh) {
            this.note({ category: 'configError', text: invalidText(this.lang, error.id, error.problem) });
        }
        const next = new Map(watches.map(watch => [watch.id, watch]));
        for (const id of this.runtime.keys()) {
            if (!next.has(id)) {
                this.runtime.delete(id);
                this.written.delete(id);
            }
        }
        this.watches = next;
        this.sids = new Map(watches.map(watch => [watch.sid, watch.id]));
        for (const watch of watches) {
            if (this.stopping) {
                return;
            }
            const rt = this.runtime.get(watch.id);
            if (!rt) {
                await this.addWatch(watch);
            } else if (this.recreate.has(watch.id)) {
                await this.ensureObjects(watch, rt.name);
                this.written.delete(watch.id);
            }
        }
        this.recreate.clear();
        await this.sweepOrphans();
        this.log.info(`Watching ${watches.length} state(s).`);
    }

    private async ensureObjects(watch: Watch, name: string): Promise<void> {
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
    }

    private async addWatch(watch: Watch): Promise<void> {
        const source = await this.getForeignObjectAsync(watch.id);
        const name = displayName(source?.common?.name, this.lang, watch.id);
        await this.ensureObjects(watch, name);
        const base = `watches.${watch.sid}`;
        const [status, since, restarts] = await Promise.all([
            this.getStateAsync(`${base}.status`),
            this.getStateAsync(`${base}.since`),
            this.getStateAsync(`${base}.restarts`),
        ]);
        const attempts = typeof restarts?.val === 'number' ? restarts.val : 0;
        if (attempts > 0 && watch.owner && !this.instanceRestarts.has(watch.owner)) {
            // The instance lock is not stored; assume the last restart at our start, like the watch does.
            this.instanceRestarts.set(watch.owner, this.startTime);
        }
        this.runtime.set(
            watch.id,
            restoreRuntime(
                name,
                isStatus(status?.val) ? status.val : null,
                typeof since?.val === 'number' ? since.val : null,
                attempts,
                this.startTime,
            ),
        );
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
            if (this.stopping) {
                return;
            }
            const state = states[watch.id];
            // One broken watch must not stop the others.
            try {
                await this.applyStatus(watch, state ? { ts: state.ts, lc: state.lc } : null, now);
            } catch (error) {
                this.log.warn(`Cannot check ${watch.id}: ${errText(error)}. Trying again with the next check.`);
            }
        }
        await this.flushNotes();
        await this.writeSummary();
    }

    private async applyStatus(watch: Watch, observed: Observed | null, now: number): Promise<void> {
        const before = this.runtime.get(watch.id);
        if (!before) {
            return;
        }
        // A watch that was stale before a restart is judged by its raw timestamp, or the grace
        // would report a false recovery on the first cycle.
        const status = statusOf(watch, observed, now, before.status === 'stale' ? 0 : this.startTime);
        const owner = watch.owner;
        const instanceEnabled =
            owner !== null && restartPossible(watch, before, status) ? await this.instanceEnabled(owner) : false;
        const { rt, notes, restart } = step({
            watch,
            rt: before,
            status,
            observed,
            now,
            instanceEnabled,
            lastInstanceRestart: owner ? this.instanceRestarts.get(owner) : undefined,
            lockMs: this.lockMs,
            lang: this.lang,
        });
        this.runtime.set(watch.id, rt);
        for (const note of notes) {
            this.note(note);
        }

        if (restart) {
            this.instanceRestarts.set(restart, now);
            if (before.status === 'stale') {
                this.log.info(
                    `Restarting ${restart} again (attempt ${rt.restart.attempts} of ${watch.restartAttempts}), ${watch.id} is still silent.`,
                );
            }
            try {
                await this.extendForeignObjectAsync(`system.adapter.${restart}`, { common: { enabled: true } });
            } catch (error) {
                this.note({ category: 'configError', text: restartFailedText(this.lang, restart, errText(error)) });
            }
        }

        const snapshot = `${rt.status}|${rt.since}|${rt.restart.attempts}`;
        if (this.written.get(watch.id) !== snapshot) {
            const base = `watches.${watch.sid}`;
            await this.setStateChangedAsync(`${base}.stale`, rt.status === 'stale', true);
            await this.setStateChangedAsync(`${base}.status`, rt.status, true);
            await this.setStateChangedAsync(`${base}.since`, rt.since, true);
            await this.setStateChangedAsync(`${base}.restarts`, rt.restart.attempts, true);
            this.written.set(watch.id, snapshot);
        }
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

    /**
     * Logs one notification line now; the notification itself goes out with the others of this
     * check in `flushNotes`.
     *
     * @param note category and text
     */
    private note(note: Note): void {
        if (note.category === 'recovered') {
            this.log.info(note.text);
        } else {
            this.log.warn(note.text);
        }
        this.notes.push(note);
    }

    /** Raises one notification per category for all lines collected since the last flush. */
    private async flushNotes(): Promise<void> {
        const notes = this.notes;
        this.notes = [];
        for (const category of CATEGORIES) {
            const lines = notes.filter(note => note.category === category).map(note => note.text);
            if (lines.length === 0 || this.stopping) {
                continue;
            }
            try {
                await this.registerNotification('staleguard', category, joinLines(this.lang, lines));
            } catch (error) {
                this.log.warn(`Cannot raise the notification: ${errText(error)}`);
            }
        }
    }

    private scheduleReload(): void {
        if (this.reloadTimer) {
            this.clearTimeout(this.reloadTimer);
        }
        this.reloadTimer = this.setTimeout(() => {
            this.reloadTimer = undefined;
            void this.serial(() => this.loadWatches());
        }, RELOAD_DEBOUNCE_MS);
    }

    private onObjectChange(id: string, obj: ioBroker.Object | null | undefined): void {
        if (this.stopping) {
            return;
        }
        if (id.startsWith(`${this.namespace}.`)) {
            this.onOwnObjectChange(id, obj);
            return;
        }
        // A deleted object keeps its watch, which then reports `missing`.
        if (!obj) {
            return;
        }
        if (id === 'system.config') {
            this.lang = pickLang((obj.common as { language?: unknown } | undefined)?.language);
            return;
        }
        const rt = this.runtime.get(id);
        const watch = this.watches.get(id);
        if (rt && watch) {
            const name = displayName(obj.common?.name, this.lang, id);
            if (name !== rt.name) {
                rt.name = name;
                void this.serial(() =>
                    this.extendObjectAsync(`watches.${watch.sid}`, { common: { name: `${name} (${id})` } }).then(
                        () => undefined,
                        (error: unknown) =>
                            this.log.warn(`Cannot rename the watch channel of ${id}: ${errText(error)}`),
                    ),
                );
            }
        }
        const custom = (obj.common as { custom?: Record<string, unknown> } | undefined)?.custom;
        if (custom?.[this.namespace] === undefined && !watch) {
            return;
        }
        this.scheduleReload();
    }

    /**
     * Recreates the channel or states of a watch that someone deleted from outside.
     *
     * @param id own object id
     * @param obj the object, null when deleted
     */
    private onOwnObjectChange(id: string, obj: ioBroker.Object | null | undefined): void {
        const prefix = `${this.namespace}.watches.`;
        if (obj || !id.startsWith(prefix)) {
            return;
        }
        // Sids contain no dot, so the first segment after the prefix is the sid.
        const watchId = this.sids.get(id.slice(prefix.length).split('.')[0]);
        if (watchId !== undefined && this.watches.has(watchId)) {
            this.recreate.add(watchId);
            this.scheduleReload();
        }
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
