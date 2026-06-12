# Deploy Nuclio Functions with Node-Red.

Deploy Nuclio Functions directly from a Node-Red script. These are essentially Python or Go HTTP endpoints that nodered calls.

The "nuclio" node acts essentially like a function node, giving you a code editor. Once the node is deployed, it will deploy the function to nuclio and act as an HTTP request node, making requests to the nuclio function.

> NOTE: This node is specifically intended for the `sourceCode` [code entry type](https://docs.nuclio.io/en/latest/reference/function-configuration/code-entry-types.html) and the default [HTTP trigger](https://docs.nuclio.io/en/latest/reference/triggers/http.html), though there isn't anything stopping you from customizing the function config to get the desired functionality (e.g. setting `spec.image` or `build.codeEntryType=archive, build.path=<URL>`). 

## Install

> This is a prototype - I look forward to hearing your experience, feedback, and ideas for improvements.

```bash
npm i @bea.steers/node-red-contrib-nuclio
```

In order to use this node, you must have the Nuclio dashboard running. It doesn't need to be public, it just needs to be accessible by Node-Red.

Using the docker-compose test install below will give you a fully functioning system to experiment with.

## Test Install
To test/develop
```bash
docker-compose up -d --build
```
Unit tests and lint:
```bash
npm test
npm run lint
```
You can access: 
 * Node-Red dashboard [here](http://localhost:1881). 
 * The Nuclio dashboard can be found [here](http://localhost:8070).

## Tuning

All cadence and self-healing behavior is controlled by environment variables (sane defaults shown):

| Variable | Default | Purpose |
| --- | --- | --- |
| `NUCLIO_POLL_MS` | `1000` | Poll interval while a function is building/transitioning. |
| `NUCLIO_READY_POLL_MS` | `5000` | Poll interval once a function is healthy. |
| `NUCLIO_BACKOFF_MS` | `5000` | First retry delay after a dashboard error (doubles each failure). |
| `NUCLIO_BACKOFF_MAX_MS` | `60000` | Cap on the exponential backoff. |
| `NUCLIO_START_STAGGER_MS` | `2000` | Window to spread first-deploys across on startup. |
| `NUCLIO_MAX_SELF_HEAL_ATTEMPTS` | `5` | Auto-redeploys of an unhealthy function before giving up. |
| `NUCLIO_AUTO_REDEPLOY_ON_ERROR` | `false` | Also auto-redeploy functions in Nuclio's `error` state. |
| `NUCLIO_REDEPLOY_DEADLINE_MS` | `120000` | How long a redeploy may run before it's treated as failed. |
| `NUCLIO_*_TIMEOUT_MS` | varies | Request/deploy/invocation HTTP timeouts. |

## Hacks
[bug](https://github.com/nuclio/nuclio/issues/3968)
```bash
docker exec nuclio apk add --no-cache docker-cli-buildx
```