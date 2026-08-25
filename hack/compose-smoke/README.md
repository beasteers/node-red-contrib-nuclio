# Compose smoke fixture

This is maintainer-only integration infrastructure for `npm run smoke`. It is
separate from the root Compose gallery and never modifies the tracked demo
flow in `data/flows.json`.

The fixture contains only Node-RED, the Nuclio dashboard, and one minimal HTTP
flow. Its stress scenario is available at
[`stress-scenario.json`](stress-scenario.json) for repeatable fixed-scale load
testing after the stack is started.
