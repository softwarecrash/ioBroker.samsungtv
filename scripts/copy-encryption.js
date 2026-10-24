'use strict';

// The vendored crypto of the H/J pairing (bn.js, asmcrypto) must reach build/ unchanged:
// compiled by tsc it gets "use strict" prepended, and asmcrypto then fails on load.
// tsc only reads its typings (index.d.ts); this copies the JavaScript next to the compiled code.
const fs = require('node:fs');
const path = require('node:path');

const source = path.join(__dirname, '..', 'src', 'lib', 'hj', 'Pairing', 'Encryption');
const target = path.join(__dirname, '..', 'build', 'lib', 'hj', 'Pairing', 'Encryption');

fs.mkdirSync(target, { recursive: true });
for (const file of fs.readdirSync(source)) {
    if (file.endsWith('.js')) {
        fs.copyFileSync(path.join(source, file), path.join(target, file));
    }
}
