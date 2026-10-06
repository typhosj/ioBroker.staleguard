import { expect } from 'chai';
import type { Status } from './evaluate';
import { emptyRestart } from './restart';
import { restartPossible, restoreRuntime, step, type StepInput, type WatchRuntime } from './transition';
import type { Watch } from './watchlist';

const MINUTE = 60_000;
const T0 = new Date('2026-10-05T12:00:00Z').getTime();
const watch: Watch = {
    id: 'ical.0.data.count',
    sid: 'ical__0__data__count',
    timeoutMs: 30 * MINUTE,
    mode: 'update',
    restartAttempts: 2,
    owner: 'ical.0',
};

function runtime(status: Status, overrides: Partial<WatchRuntime> = {}): WatchRuntime {
    return { name: 'Count', status, since: T0 - 60 * MINUTE, restart: emptyRestart(), ...overrides };
}

function input(overrides: Partial<StepInput> = {}): StepInput {
    return {
        watch,
        rt: runtime('ok'),
        status: 'ok',
        observed: { ts: T0 - 31 * MINUTE, lc: T0 - 31 * MINUTE },
        now: T0,
        instanceEnabled: true,
        lastInstanceRestart: undefined,
        lockMs: 60 * MINUTE,
        lang: 'en',
        ...overrides,
    };
}

describe('transition', () => {
    it('reports ok → stale once, with the restart, and records the time', () => {
        const result = step(input({ status: 'stale' }));
        expect(result.restart).to.equal('ical.0');
        expect(result.rt).to.include({ status: 'stale', since: T0 });
        expect(result.rt.restart.attempts).to.equal(1);
        expect(result.notes).to.deep.equal([
            {
                category: 'stale',
                text: "No sign of life from 'Count' (ical.0.data.count) for 31 min. Restarting instance ical.0.",
            },
        ]);
    });

    it('stays quiet while a state stays stale before the next attempt is due', () => {
        const rt = runtime('stale', { restart: { attempts: 1, lastRestartAt: T0, gaveUp: false } });
        const result = step(input({ rt, status: 'stale', now: T0 + 29 * MINUTE }));
        expect(result.notes).to.deep.equal([]);
        expect(result.restart).to.equal(null);
    });

    it('restarts again one deadline later and gives up once after the last attempt', () => {
        const first = { attempts: 1, lastRestartAt: T0, gaveUp: false };
        const second = step(
            input({ rt: runtime('stale', { restart: first }), status: 'stale', now: T0 + 30 * MINUTE }),
        );
        expect(second.restart).to.equal('ical.0');
        expect(second.notes).to.deep.equal([]);

        const third = step(input({ rt: second.rt, status: 'stale', now: T0 + 60 * MINUTE }));
        expect(third.restart).to.equal(null);
        expect(third.notes.map(note => note.category)).to.deep.equal(['stale']);
        expect(third.notes[0].text).to.contain('after 2 restart(s)');

        const fourth = step(input({ rt: third.rt, status: 'stale', now: T0 + 90 * MINUTE }));
        expect(fourth.notes).to.deep.equal([]);
    });

    it('reports stale → ok as recovered and resets the restart counter', () => {
        const rt = runtime('stale', { restart: { attempts: 2, lastRestartAt: T0, gaveUp: true } });
        const result = step(input({ rt }));
        expect(result.notes.map(note => note.category)).to.deep.equal(['recovered']);
        expect(result.rt.restart).to.deep.equal(emptyRestart());
    });

    it('does not report missing → ok as a recovery, it is a first value', () => {
        const result = step(input({ rt: runtime('missing') }));
        expect(result.notes).to.deep.equal([]);
        expect(result.rt).to.include({ status: 'ok', since: T0 });
    });

    for (const from of ['ok', 'stale'] as const) {
        it(`reports ${from} → missing as a watch problem`, () => {
            const result = step(input({ rt: runtime(from), status: 'missing', observed: null }));
            expect(result.notes.map(note => note.category)).to.deep.equal(['configError']);
            expect(result.restart).to.equal(null);
        });
    }

    it('does not restart a disabled instance but still reports the outage', () => {
        const result = step(input({ status: 'stale', instanceEnabled: false }));
        expect(result.restart).to.equal(null);
        expect(result.notes[0].text).to.not.contain('Restarting');
    });

    it('asks for the instance only when a restart decision is possible', () => {
        expect(restartPossible(watch, runtime('ok'), 'stale')).to.equal(true);
        expect(restartPossible(watch, runtime('ok'), 'ok')).to.equal(false);
        expect(restartPossible({ ...watch, restartAttempts: 0 }, runtime('ok'), 'stale')).to.equal(false);
        expect(restartPossible({ ...watch, owner: null }, runtime('ok'), 'stale')).to.equal(false);
        const gaveUp = runtime('stale', { restart: { attempts: 2, lastRestartAt: T0, gaveUp: true } });
        expect(restartPossible(watch, gaveUp, 'stale')).to.equal(false);
    });

    describe('restoreRuntime', () => {
        it('defaults a watch without stored states to ok since the start', () => {
            expect(restoreRuntime('Count', null, null, 0, T0)).to.deep.equal({
                name: 'Count',
                status: 'ok',
                since: T0,
                restart: emptyRestart(),
            });
        });

        it('still sends the give-up notification when Staleguard restarted after the last attempt', () => {
            const rt = restoreRuntime('Count', 'stale', T0 - 90 * MINUTE, 2, T0);
            expect(step(input({ rt, status: 'stale', now: T0 + 29 * MINUTE })).notes).to.deep.equal([]);
            const due = step(input({ rt, status: 'stale', now: T0 + 30 * MINUTE }));
            expect(due.notes.map(note => note.category)).to.deep.equal(['stale']);
            expect(due.notes[0].text).to.contain('No further attempts');
        });
    });
});
