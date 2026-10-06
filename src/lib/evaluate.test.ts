import { expect } from 'chai';
import { isStatus, lastSign, statusOf } from './evaluate';

const MINUTE = 60_000;
const T0 = new Date('2026-10-05T12:00:00Z').getTime();
const update = { mode: 'update' as const, timeoutMs: 30 * MINUTE };
const change = { mode: 'change' as const, timeoutMs: 30 * MINUTE };

describe('evaluate', () => {
    it('reads ts in update mode and lc in change mode', () => {
        const observed = { ts: T0, lc: T0 - 5 * MINUTE };
        expect(lastSign(update, observed)).to.equal(T0);
        expect(lastSign(change, observed)).to.equal(T0 - 5 * MINUTE);
    });

    it('is missing without a state', () => {
        expect(statusOf(update, null, T0, 0)).to.equal('missing');
    });

    it('is missing when the timestamp is not a finite number', () => {
        expect(statusOf(update, { ts: Number.NaN, lc: T0 }, T0, 0)).to.equal('missing');
    });

    it('is ok exactly at the deadline and stale one millisecond later', () => {
        const observed = { ts: T0, lc: T0 };
        expect(statusOf(update, observed, T0 + 30 * MINUTE, 0)).to.equal('ok');
        expect(statusOf(update, observed, T0 + 30 * MINUTE + 1, 0)).to.equal('stale');
    });

    it('treats a fresh update with an old value as ok in update mode and stale in change mode', () => {
        const observed = { ts: T0, lc: T0 - 60 * MINUTE };
        expect(statusOf(update, observed, T0 + MINUTE, 0)).to.equal('ok');
        expect(statusOf(change, observed, T0 + MINUTE, 0)).to.equal('stale');
    });

    it('gives an old state the full deadline after Staleguard started', () => {
        const observed = { ts: T0 - 24 * 60 * MINUTE, lc: T0 - 24 * 60 * MINUTE };
        expect(statusOf(update, observed, T0 + 10 * MINUTE, T0)).to.equal('ok');
        expect(statusOf(update, observed, T0 + 31 * MINUTE, T0)).to.equal('stale');
    });

    it('evaluates the raw timestamp when the grace is off', () => {
        const observed = { ts: T0 - 24 * 60 * MINUTE, lc: T0 - 24 * 60 * MINUTE };
        expect(statusOf(update, observed, T0 + MINUTE, 0)).to.equal('stale');
    });

    it('stays ok while ts lies in the future (clock moved back)', () => {
        const observed = { ts: T0 + 120 * MINUTE, lc: T0 + 120 * MINUTE };
        expect(statusOf(update, observed, T0, 0)).to.equal('ok');
    });

    it('recognizes valid status strings only', () => {
        expect(isStatus('stale')).to.equal(true);
        expect(isStatus('dead')).to.equal(false);
        expect(isStatus(null)).to.equal(false);
    });
});
