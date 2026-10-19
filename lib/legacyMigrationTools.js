'use strict';

function shouldMigrateLegacySamsung(instance) {
    return Number(instance) === 0;
}

module.exports = { shouldMigrateLegacySamsung };
