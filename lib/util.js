const _ = require('lodash');


// treat missing/empty containers as equal (e.g. {} vs undefined vs ''), but never
// scalars - _.isEmpty(2) === true, which would swallow numeric/boolean changes
const isEmptyish = (x) => x == null || ((_.isObject(x) || _.isString(x)) && _.isEmpty(x));

function diff(a,b) {
    var r = {};
    _.each(a, function(v,k) {
        if(b?.[k] === v) return;
        let v2 = _.isObject(v) ? diff(v, b?.[k]) : v;
        if(_.isObject(v2) && _.isEmpty(v2)) return;
        if(isEmptyish(v) && isEmptyish(b?.[k])) return;
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


// debounce with a hard ceiling so rapid status churn still renders periodically
const debounced = (fn, delay, maxWait) => _.debounce(fn, delay, { maxWait });

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