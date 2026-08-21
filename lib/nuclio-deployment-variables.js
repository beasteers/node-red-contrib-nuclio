const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_INTERPOLATION_DEPTH = 32;

const asString = value => value == null ? '' : String(value);

const parseEntries = (entries) => {
    if (!Array.isArray(entries)) return [];
    return entries.filter(entry => entry && typeof entry === 'object' && entry.name)
        .map(entry => ({
            name: String(entry.name),
            type: entry.type || 'str',
            value: entry.value,
            secret: entry.secret === true || entry.type === 'cred',
        }));
};

const resolveEntries = (RED, node, entries) => {
    const variables = new Map();
    for (const entry of parseEntries(entries)) {
        if (!VARIABLE_NAME.test(entry.name)) {
            throw new Error(`Invalid deployment variable name "${entry.name}"`);
        }
        if (!['str', 'env', 'cred'].includes(entry.type)) {
            throw new Error(`Unsupported deployment variable type "${entry.type}" for ${entry.name}`);
        }
        if (variables.has(entry.name)) {
            throw new Error(`Duplicate deployment variable "${entry.name}"`);
        }

        let value;
        if (entry.type === 'env') {
            value = RED.util.evaluateNodeProperty(entry.value || '', 'env', node);
        } else if (entry.type === 'cred') {
            // The complete variable list is stored in Node-RED credentials, so
            // the credential value can be kept as-is without copying it into
            // the flow or writing it to logs.
            value = entry.value;
        } else {
            value = entry.value;
        }
        variables.set(entry.name, { value, secret: entry.secret });
    }
    return variables;
};

const findClosingBrace = (input, start) => {
    let depth = 1;
    for (let index = start + 2; index < input.length; index += 1) {
        if (input[index] === '{') depth += 1;
        else if (input[index] === '}' && --depth === 0) return index;
    }
    throw new Error('Unclosed deployment variable expression');
};

const findDefaultSeparator = expression => {
    let depth = 0;
    for (let index = 0; index < expression.length - 1; index += 1) {
        if (expression[index] === '{') depth += 1;
        else if (expression[index] === '}') depth -= 1;
        else if (depth === 0 && expression[index] === ':' && expression[index + 1] === '-') return index;
    }
    return -1;
};

const interpolateString = (input, variables, depth = 0) => {
    if (depth > MAX_INTERPOLATION_DEPTH) {
        throw new Error('Deployment variable interpolation is nested too deeply');
    }

    let output = '';
    let secret = false;
    for (let index = 0; index < input.length;) {
        if (input[index] !== '$' || input[index + 1] !== '{') {
            output += input[index++];
            continue;
        }

        const end = findClosingBrace(input, index);
        const expression = input.slice(index + 2, end);
        const separator = findDefaultSeparator(expression);
        const name = separator === -1 ? expression : expression.slice(0, separator);
        const variable = variables.get(name);
        if (!VARIABLE_NAME.test(name)) {
            throw new Error(`Invalid deployment variable expression "${expression}"`);
        }

        if (variable?.value !== undefined && variable.value !== null && variable.value !== '') {
            output += asString(variable.value);
            secret ||= variable.secret;
        } else if (separator !== -1) {
            const fallback = interpolateString(expression.slice(separator + 2), variables, depth + 1);
            output += fallback.value;
            secret ||= fallback.secret;
        } else if (!variable) {
            throw new Error(`Deployment variable "${name}" is not defined`);
        } else {
            // Match Bash's ${VAR} behavior for a declared-but-empty value.
            output += '';
            secret ||= variable.secret;
        }
        index = end + 1;
    }
    return { value: output, secret };
};

const interpolateConfig = (config, variables) => {
    const secretPaths = [];
    const visit = (value, path) => {
        if (typeof value === 'string') {
            const result = interpolateString(value, variables);
            if (result.secret) secretPaths.push(path.join('.'));
            return result.value;
        }
        if (Array.isArray(value)) return value.map((item, index) => visit(item, [...path, index]));
        if (value && typeof value === 'object') {
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item, [...path, key])]));
        }
        return value;
    };
    return { value: visit(config, []), secretPaths };
};

module.exports = {
    VARIABLE_NAME,
    interpolateConfig,
    interpolateString,
    parseEntries,
    resolveEntries,
};
