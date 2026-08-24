/* Shared command-line helpers for the stress-test runners. */

const optionValue = (argv, name) => {
    const prefix = `--${name}`;
    const argument = argv.find(value => value === prefix || value.startsWith(`${prefix}=`));
    if (!argument) return undefined;
    const inline = argument.slice(prefix.length + 1);
    if (inline) return inline;
    return argv[argv.indexOf(argument) + 1];
};

const toStressArgs = (values, rate) => Object.entries({ ...values, ...(rate === undefined ? {} : { rate }) })
    .filter(([, value]) => value !== undefined && value !== null && value !== false)
    .flatMap(([name, value]) => [`--${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, String(value)]);

module.exports = { optionValue, toStressArgs };
