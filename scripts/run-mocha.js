'use strict';

const { spawnSync } = require('child_process');

function resolveMochaBin() {
    const candidates = ['mocha/bin/mocha', '@iobroker/testing/node_modules/mocha/bin/mocha'];
    for (const mod of candidates) {
        try {
            return require.resolve(mod);
        } catch {
            // try next candidate
        }
    }
    return '';
}

const mochaBin = resolveMochaBin();
if (!mochaBin) {
    console.error('Mocha binary not found. Run "npm install" and ensure @iobroker/testing is installed.');
    process.exit(1);
}

const args = process.argv.slice(2);
const result = spawnSync(process.execPath, [mochaBin, ...args], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env,
});

if (typeof result.status === 'number') {
    process.exit(result.status);
}

process.exit(1);
