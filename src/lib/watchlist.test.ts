import { expect } from 'chai';
import {
    buildWatchlist,
    customChanged,
    customKeys,
    freshErrors,
    normalizeNative,
    ownerInstance,
    parseCustom,
    toSid,
    type WatchError,
} from './watchlist';

// Same pattern as adapter-core's FORBIDDEN_CHARS; the adapter passes this.FORBIDDEN_CHARS.
const FORBIDDEN = /[^._\-/ :!#$%&()+=@^{}|~\p{Ll}\p{Lu}\p{Nd}]+/gu;
const NS = 'staleguard.0';
const valid = { enabled: true, timeoutMin: 30, mode: 'change', restartAttempts: 2 };

describe('watchlist', () => {
    describe('toSid', () => {
        it('flattens dots into a single level', () => {
            expect(toSid('hm-rpc.0.ABC:1.STATE', FORBIDDEN)).to.equal('hm-rpc__0__ABC:1__STATE');
        });
        it('replaces forbidden characters', () => {
            expect(toSid('x.0.a*b[c]', FORBIDDEN)).to.equal('x__0__a_b_c_');
        });
    });

    describe('ownerInstance', () => {
        it('returns the instance of an adapter state', () => {
            expect(ownerInstance('electrolux-aeg.0.dev.status', NS)).to.equal('electrolux-aeg.0');
        });
        for (const id of [
            'alias.0.x',
            '0_userdata.0.x',
            'system.adapter.shelly.0.alive',
            'staleguard.0.summary.stale',
            'javascript',
        ]) {
            it(`returns null for ${id}`, () => {
                expect(ownerInstance(id, NS)).to.equal(null);
            });
        }
    });

    describe('parseCustom', () => {
        it('returns null when the entry is missing or disabled', () => {
            expect(parseCustom('a.0.x', undefined, NS, FORBIDDEN)).to.equal(null);
            expect(parseCustom('a.0.x', { ...valid, enabled: false }, NS, FORBIDDEN)).to.equal(null);
        });
        it('builds a watch from a valid entry', () => {
            expect(parseCustom('a.0.x', valid, NS, FORBIDDEN)).to.deep.equal({
                watch: {
                    id: 'a.0.x',
                    sid: 'a__0__x',
                    timeoutMs: 30 * 60_000,
                    mode: 'change',
                    restartAttempts: 2,
                    owner: 'a.0',
                },
            });
        });
        it('applies defaults for missing keys', () => {
            expect(parseCustom('0_userdata.0.x', { enabled: true }, NS, FORBIDDEN)).to.deep.equal({
                watch: {
                    id: '0_userdata.0.x',
                    sid: '0_userdata__0__x',
                    timeoutMs: 60 * 60_000,
                    mode: 'update',
                    restartAttempts: 0,
                    owner: null,
                },
            });
        });
        for (const timeoutMin of [0, -1, Number.NaN, 10081, '30', 1.5]) {
            it(`rejects deadline ${String(timeoutMin)}`, () => {
                expect(parseCustom('a.0.x', { ...valid, timeoutMin }, NS, FORBIDDEN)).to.deep.equal({
                    error: { id: 'a.0.x', problem: { code: 'timeout', value: timeoutMin } },
                });
            });
        }
        it('accepts the deadline boundaries 1 and 10080', () => {
            expect(parseCustom('a.0.x', { ...valid, timeoutMin: 1 }, NS, FORBIDDEN)).to.have.property('watch');
            expect(parseCustom('a.0.x', { ...valid, timeoutMin: 10080 }, NS, FORBIDDEN)).to.have.property('watch');
        });
        it('rejects an unknown mode', () => {
            expect(parseCustom('a.0.x', { ...valid, mode: 'value' }, NS, FORBIDDEN)).to.deep.equal({
                error: { id: 'a.0.x', problem: { code: 'mode', value: 'value' } },
            });
        });
        for (const restartAttempts of [-1, 6, 2.5]) {
            it(`rejects restart attempts ${restartAttempts}`, () => {
                expect(parseCustom('a.0.x', { ...valid, restartAttempts }, NS, FORBIDDEN)).to.deep.equal({
                    error: { id: 'a.0.x', problem: { code: 'attempts', value: restartAttempts } },
                });
            });
        }
        it('rejects restarts for a state without an owning instance', () => {
            expect(parseCustom('alias.0.x', valid, NS, FORBIDDEN)).to.deep.equal({
                error: { id: 'alias.0.x', problem: { code: 'noOwner' } },
            });
        });
        it('rejects watching its own states', () => {
            expect(parseCustom('staleguard.0.summary.stale', { enabled: true }, NS, FORBIDDEN)).to.deep.equal({
                error: { id: 'staleguard.0.summary.stale', problem: { code: 'ownStates' } },
            });
        });
    });

    describe('buildWatchlist', () => {
        it('rejects the second of two ids that map to the same sid', () => {
            const result = buildWatchlist(
                [
                    { id: 'a.0.x__y', custom: { enabled: true } },
                    { id: 'a.0.x.y', custom: { enabled: true } },
                ],
                NS,
                FORBIDDEN,
            );
            expect(result.watches.map(w => w.id)).to.deep.equal(['a.0.x.y']);
            expect(result.errors).to.deep.equal([{ id: 'a.0.x__y', problem: { code: 'collision', other: 'a.0.x.y' } }]);
        });
        it('caps the list and reports the rest', () => {
            const entries = ['a.0.1', 'a.0.2', 'a.0.3'].map(id => ({ id, custom: { enabled: true } }));
            const result = buildWatchlist(entries, NS, FORBIDDEN, 2);
            expect(result.watches).to.have.length(2);
            expect(result.errors).to.deep.equal([{ id: 'a.0.3', problem: { code: 'cap', max: 2 } }]);
        });
        it('skips disabled entries without an error', () => {
            const result = buildWatchlist([{ id: 'a.0.1', custom: { enabled: false } }], NS, FORBIDDEN);
            expect(result).to.deep.equal({ watches: [], errors: [] });
        });
    });

    describe('customChanged', () => {
        const keys = customKeys([
            { id: 'a.0.x', custom: valid },
            { id: 'a.0.history', custom: undefined },
            { id: 'a.0.cleared', custom: null },
        ]);

        it('ignores a change of a watched object that leaves its entry as it was', () => {
            expect(customChanged(keys, 'a.0.x', { ...valid })).to.equal(false);
        });
        it('ignores objects without an entry, before and now', () => {
            expect(customChanged(keys, 'a.0.history', undefined)).to.equal(false);
            expect(customChanged(keys, 'a.0.cleared', null)).to.equal(false);
            expect(customChanged(keys, 'a.0.unknown', undefined)).to.equal(false);
        });
        it('sees a changed, removed or new entry', () => {
            expect(customChanged(keys, 'a.0.x', { ...valid, timeoutMin: 31 })).to.equal(true);
            expect(customChanged(keys, 'a.0.x', { ...valid, enabled: false })).to.equal(true);
            expect(customChanged(keys, 'a.0.x', undefined)).to.equal(true);
            expect(customChanged(keys, 'a.0.x', null)).to.equal(true);
            expect(customChanged(keys, 'a.0.unknown', valid)).to.equal(true);
        });
    });

    describe('freshErrors', () => {
        const mode: WatchError = { id: 'a.0.x', problem: { code: 'mode', value: 'value' } };
        const deadline: WatchError = { id: 'a.0.x', problem: { code: 'timeout', value: 0 } };

        it('reports an error once while it persists', () => {
            const first = freshErrors([mode], new Set());
            expect(first.fresh).to.deep.equal([mode]);
            expect(freshErrors([mode], first.reported).fresh).to.deep.equal([]);
        });
        it('reports an error again after it was fixed in between', () => {
            const broken = freshErrors([mode], new Set());
            const fixed = freshErrors([], broken.reported);
            expect(fixed).to.deep.equal({ fresh: [], reported: new Set() });
            expect(freshErrors([mode], fixed.reported).fresh).to.deep.equal([mode]);
        });
        it('reports a different problem of the same state', () => {
            const broken = freshErrors([mode], new Set());
            expect(freshErrors([deadline], broken.reported).fresh).to.deep.equal([deadline]);
        });
    });

    describe('normalizeNative', () => {
        it('keeps valid values', () => {
            expect(normalizeNative({ checkIntervalSec: 30, restartLockMin: 120 })).to.deep.equal({
                checkIntervalSec: 30,
                restartLockMin: 120,
                warnings: [],
            });
        });
        it('clamps out-of-range values and warns', () => {
            const result = normalizeNative({ checkIntervalSec: 1, restartLockMin: 99999 });
            expect(result.checkIntervalSec).to.equal(10);
            expect(result.restartLockMin).to.equal(1440);
            expect(result.warnings).to.have.length(2);
        });
        it('falls back to defaults for non-numbers and warns', () => {
            const result = normalizeNative({ checkIntervalSec: 'fast', restartLockMin: Number.POSITIVE_INFINITY });
            expect(result.checkIntervalSec).to.equal(60);
            expect(result.restartLockMin).to.equal(60);
            expect(result.warnings).to.have.length(2);
        });
    });
});
