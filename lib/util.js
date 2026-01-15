const _ = require('lodash');


function diff(a,b) {
    var r = {};
    _.each(a, function(v,k) {
        if(b?.[k] === v) return;
        let v2 = _.isObject(v) ? diff(v, b?.[k]) : v;
        if(_.isObject(v2) && _.isEmpty(v2)) return;
        if(_.isEmpty(v) && _.isEmpty(b?.[k])) return;
        r[k] = v2;
    });
    return r;
}

function merge(...args) {
    return _.mergeWith(...args, function(a, b) {
        if (_.isArray(b)) {
            return b;
        }
    });
}

function nestedAssign(obj, path, value) {
    const keys = splitByDotWithEscape(path);
    const lastKey = keys.pop();
    let current = obj;
    for (const key of keys) {
        if (!(key in current) || typeof current[key] !== 'object' || current[key] === null) {
            current[key] = {};
        }
        current = current[key];
    }
    current[lastKey] = value;
}


function debounced(fn, delay, maxWait) {
    let timeout = null;
    let lastCall = null;
    let maxTimeout = null;

    return function debounced(...args) {
        const now = Date.now();

        if (!lastCall) lastCall = now;

        clearTimeout(timeout);
        timeout = setTimeout(() => {
            fn.apply(this, args);
            lastCall = null;
            clearTimeout(maxTimeout);
            maxTimeout = null;
        }, delay);

        if (!maxTimeout) {
            maxTimeout = setTimeout(() => {
                fn.apply(this, args);
                lastCall = null;
                clearTimeout(timeout);
                timeout = null;
            }, maxWait);
        }
    };
}

const parseIntFallback = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
};


const asString = (value) => {
    if (typeof value === 'string') return value;
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

function splitByDotWithEscape(str) {
    return str.split(/(?<!\\)\./).map(part => part.replace(/\\\./g, '.'));
}


module.exports = {
    diff, merge,
    debounced,
    parseIntFallback,
    asString,
    splitByDotWithEscape,
    nestedAssign,
};