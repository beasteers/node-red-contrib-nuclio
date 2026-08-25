module.exports = {
    flowFile: 'flows.json',
    flowFilePretty: true,
    uiPort: Number(process.env.NODE_RED_PORT || 1880),
    editorTheme: { tours: false },
    logging: { console: { level: 'info' } },
};
