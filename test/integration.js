const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { expect } = require('chai');
const { tests } = require('@iobroker/testing');

const DUMP = path.join(os.tmpdir(), 'staleguard.0.json');

function call(fn, ...args) {
    return new Promise((resolve, reject) => fn(...args, (err, result) => (err ? reject(err) : resolve(result))));
}

tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('watches states from their custom settings', getHarness => {
            it('reports ok for a live state, missing for a state without value, and writes a dump', async function () {
                this.timeout(60_000);
                const harness = getHarness();
                const custom = {
                    'staleguard.0': { enabled: true, timeoutMin: 60, mode: 'update', restartAttempts: 0 },
                };
                for (const id of ['0_userdata.0.sgLive', '0_userdata.0.sgEmpty']) {
                    await call(harness.objects.setObject.bind(harness.objects), id, {
                        type: 'state',
                        common: { name: id, type: 'number', role: 'value', read: true, write: true, custom },
                        native: {},
                    });
                }
                await call(harness.states.setState.bind(harness.states), '0_userdata.0.sgLive', { val: 1, ack: true });

                await harness.startAdapterAndWait();
                await new Promise(resolve => setTimeout(resolve, 3000));

                const get = id => call(harness.states.getState.bind(harness.states), id);
                expect((await get('staleguard.0.watches.0_userdata__0__sgLive.status')).val).to.equal('ok');
                expect((await get('staleguard.0.watches.0_userdata__0__sgEmpty.status')).val).to.equal('missing');
                expect((await get('staleguard.0.summary.watched')).val).to.equal(2);

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
    },
});
