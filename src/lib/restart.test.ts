import { expect } from 'chai';
import { afterExhausted, afterRestart, decideRestart, emptyRestart, type RestartInput } from './restart';

const MINUTE = 60_000;
const T0 = new Date('2026-10-05T12:00:00Z').getTime();

function input(overrides: Partial<RestartInput> = {}): RestartInput {
    return {
        status: 'stale',
        owner: 'electrolux-aeg.0',
        attemptsAllowed: 3,
        timeoutMs: 30 * MINUTE,
        runtime: emptyRestart(),
        instanceEnabled: true,
        lastInstanceRestart: undefined,
        lockMs: 60 * MINUTE,
        now: T0,
        ...overrides,
    };
}

describe('restart', () => {
    it('restarts on the first stale cycle', () => {
        expect(decideRestart(input())).to.equal('restart');
    });

    it('does nothing when restarts are off', () => {
        expect(decideRestart(input({ attemptsAllowed: 0 }))).to.equal('none');
    });

    it('does nothing without an owner', () => {
        expect(decideRestart(input({ owner: null }))).to.equal('none');
    });

    for (const status of ['ok', 'missing'] as const) {
        it(`does nothing while the state is ${status}`, () => {
            expect(decideRestart(input({ status }))).to.equal('none');
        });
    }

    it('never restarts a disabled instance', () => {
        expect(decideRestart(input({ instanceEnabled: false }))).to.equal('none');
    });

    it('respects the instance lock set by another watch of the same instance', () => {
        expect(decideRestart(input({ lastInstanceRestart: T0 - 10 * MINUTE }))).to.equal('none');
        expect(decideRestart(input({ lastInstanceRestart: T0 - 60 * MINUTE }))).to.equal('restart');
    });

    it('waits one full deadline after a restart before the next attempt', () => {
        const runtime = afterRestart(emptyRestart(), T0);
        const later = { runtime, lastInstanceRestart: T0, lockMs: 10 * MINUTE };
        expect(decideRestart(input({ ...later, now: T0 + 29 * MINUTE }))).to.equal('none');
        expect(decideRestart(input({ ...later, now: T0 + 30 * MINUTE }))).to.equal('restart');
    });

    it('allows exactly one attempt when one is configured, then gives up once', () => {
        const runtime = afterRestart(emptyRestart(), T0);
        const late = { attemptsAllowed: 1, runtime, lastInstanceRestart: T0, now: T0 + 30 * MINUTE };
        expect(decideRestart(input(late))).to.equal('exhausted');
        expect(decideRestart(input({ ...late, runtime: afterExhausted(runtime) }))).to.equal('none');
    });

    it('allows five attempts at most when five are configured', () => {
        let runtime = emptyRestart();
        let now = T0;
        let restarts = 0;
        for (let cycle = 0; cycle < 10; cycle++) {
            const decision = decideRestart(input({ attemptsAllowed: 5, runtime, now, lockMs: 0 }));
            if (decision === 'restart') {
                runtime = afterRestart(runtime, now);
                restarts++;
            }
            now += 30 * MINUTE;
        }
        expect(restarts).to.equal(5);
    });

    it('counts attempts and clears the give-up flag on restart', () => {
        expect(afterRestart({ attempts: 2, lastRestartAt: 1, gaveUp: true }, T0)).to.deep.equal({
            attempts: 3,
            lastRestartAt: T0,
            gaveUp: false,
        });
    });
});
