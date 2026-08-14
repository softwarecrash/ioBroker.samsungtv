'use strict';

function boundedSeconds(value, fallback, minimum, maximum) {
    const parsed = Number.parseInt(value, 10);
    const seconds = Number.isFinite(parsed) ? parsed : fallback;
    return Math.min(maximum, Math.max(minimum, seconds));
}

module.exports = { boundedSeconds };
