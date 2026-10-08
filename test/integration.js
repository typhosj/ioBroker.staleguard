const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { expect } = require('chai');
const { tests } = require('@iobroker/testing');

const DUMP = path.join(os.tmpdir(), 'staleguard.0.json');

function call(fn, ...args) {
    return new Promise((resolve, reject) => fn(...args, (err, result) => (err ? reject(err) : resolve(result))));
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Polls `read` until it returns `expected`, or fails after `timeoutMs`. */
async function waitFor(read, expected, timeoutMs) {
    const end = Date.now() + timeoutMs;
    let last;
    while (Date.now() < end) {
        last = await read();
        if (last === expected) {
            return;
        }
        await sleep(500);
    }
    expect(last).to.equal(expected);
}

async function prepare(harness, ids, timeoutMin) {
    // The harness keeps its data directory between local runs, so watched states of an earlier
    // run are still there and would be counted.
    const leftovers = await call(harness.objects.getObjectList.bind(harness.objects), {
        startkey: '0_userdata.0.sg',
        endkey: '0_userdata.0.sg香',
    });
    for (const row of leftovers.rows) {
        await call(harness.objects.delObject.bind(harness.objects), row.id);
    }
    await harness.changeAdapterConfig('staleguard', { native: { checkIntervalSec: 10 } });
    const custom = { 'staleguard.0': { enabled: true, timeoutMin, mode: 'update', restartAttempts: 0 } };
    for (const id of ids) {
        await call(harness.objects.setObject.bind(harness.objects), id, {
            type: 'state',
            common: { name: id, type: 'number', role: 'value', read: true, write: true, custom },
            native: {},
        });
    }
}

tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('watches states from their custom settings', getHarness => {
            it('reports ok and missing, recreates a deleted watch channel, and writes a dump', async function () {
                this.timeout(90_000);
                const harness = getHarness();
                await prepare(harness, ['0_userdata.0.sgLive', '0_userdata.0.sgEmpty'], 60);
                await call(harness.states.setState.bind(harness.states), '0_userdata.0.sgLive', { val: 1, ack: true });

                await harness.startAdapterAndWait();
                await sleep(3000);

                const get = async id => (await call(harness.states.getState.bind(harness.states), id))?.val;
                const status = 'staleguard.0.watches.0_userdata__0__sgLive.status';
                expect(await get(status)).to.equal('ok');
                expect(await get('staleguard.0.watches.0_userdata__0__sgEmpty.status')).to.equal('missing');
                expect(await get('staleguard.0.summary.watched')).to.equal(2);

                // Someone deletes the channel of a watch: it comes back with its states.
                const delObject = harness.objects.delObject.bind(harness.objects);
                await call(delObject, status);
                await call(harness.states.delState.bind(harness.states), status);
                await call(delObject, 'staleguard.0.watches.0_userdata__0__sgLive');
                await waitFor(get.bind(null, status), 'ok', 20_000);
                const channel = await call(
                    harness.objects.getObject.bind(harness.objects),
                    'staleguard.0.watches.0_userdata__0__sgLive',
                );
                expect(channel?.native?.sourceId).to.equal('0_userdata.0.sgLive');

                const list = await call(harness.objects.getObjectList.bind(harness.objects), {
                    startkey: 'staleguard.0.',
                    endkey: 'staleguard.0.香',
                });
                const dump = {};
                for (const row of list.rows) {
                    dump[row.id] = row.value;
                }
                fs.writeFileSync(DUMP, JSON.stringify(dump, null, 2));
            });
        });

        suite('reports a silent state and its recovery', getHarness => {
            it('goes stale after the deadline, keeps a stale status across a restart, and recovers', async function () {
                this.timeout(150_000);
                const harness = getHarness();
                const oldId = '0_userdata.0.sgOld';
                const old = 'staleguard.0.watches.0_userdata__0__sgOld';
                const restoredId = '0_userdata.0.sgRestored';
                const restored = 'staleguard.0.watches.0_userdata__0__sgRestored';
                await prepare(harness, [oldId, restoredId], 1);
                const setState = harness.states.setState.bind(harness.states);
                const hourAgo = Date.now() - 3_600_000;
                await call(setState, oldId, { val: 1, ack: true, ts: hourAgo, lc: hourAgo });
                await call(setState, restoredId, { val: 1, ack: true, ts: hourAgo, lc: hourAgo });
                // What a previous Staleguard run left behind for a watch that was already stale.
                await call(setState, `${restored}.status`, { val: 'stale', ack: true });
                await call(setState, `${restored}.since`, { val: hourAgo, ack: true });

                const get = async stateId => (await call(harness.states.getState.bind(harness.states), stateId))?.val;
                await harness.startAdapterAndWait();

                // A restored stale watch is judged by its raw timestamp, not turned ok by the start grace.
                await waitFor(get.bind(null, `${old}.status`), 'ok', 10_000);
                expect(await get(`${restored}.status`)).to.equal('stale');
                expect(await get(`${restored}.since`)).to.equal(hourAgo);

                // The start grace gives the other old state one full deadline first.
                await waitFor(get.bind(null, `${old}.status`), 'stale', 90_000);
                expect(await get(`${old}.stale`)).to.equal(true);
                expect(await get('staleguard.0.summary.stale')).to.equal(2);

                await call(setState, restoredId, { val: 2, ack: true });
                await waitFor(get.bind(null, `${restored}.status`), 'ok', 20_000);
                expect(await get(`${restored}.stale`)).to.equal(false);
                expect(await get('staleguard.0.summary.stale')).to.equal(1);
            });
        });
    },
});
