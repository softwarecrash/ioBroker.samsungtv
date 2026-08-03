const path = require('path');
const { tests } = require('@iobroker/testing');

// Test against a released controller. The testing default uses the development
// branch on newer Node.js versions, which may not initialize iobroker.json.
tests.integration(path.join(__dirname, '..'), { controllerVersion: 'latest' });
