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

Cadence and self-healing behavior is configurable **in the node editor** — connection
and polling cadence on the **Nuclio Server** config node (a "Tuning" section), recovery
policy on the **Nuclio Function** node (a "Recovery" section). Each field resolves:

> node config (numeric literal, or set the field type to `env` to reference a variable)
> → the `NUCLIO_*` environment variable below → the built-in default.

Editing a field takes effect on the next **Deploy** — no Node-RED restart. Leaving every
field blank reproduces the old env-only behavior, so existing deployments are unaffected.

**Server node (per dashboard):**

| Field / Variable | Default | Purpose |
| --- | --- | --- |
| Poll interval / `NUCLIO_POLL_MS` | `1000` | Poll interval while a function is building/transitioning. |
| Ready poll / `NUCLIO_READY_POLL_MS` | `5000` | Poll interval once a function is healthy. |
| Backoff / `NUCLIO_BACKOFF_MS` | `5000` | First retry delay after a dashboard error (doubles each failure). |
| Backoff max / `NUCLIO_BACKOFF_MAX_MS` | `60000` | Cap on the exponential backoff. |
| Start stagger / `NUCLIO_START_STAGGER_MS` | `2000` | Window to spread first-deploys across on startup. |
| Request timeout / `NUCLIO_REQUEST_TIMEOUT_MS` | `10000` | Status/admin HTTP timeout. |
| Deploy timeout / `NUCLIO_DEPLOY_TIMEOUT_MS` | `60000` | Create/update HTTP timeout. |

**Function node (per function):**

| Field / Variable | Default | Purpose |
| --- | --- | --- |
| Self-heal attempts / `NUCLIO_MAX_SELF_HEAL_ATTEMPTS` | `5` | Auto-redeploys of an unhealthy function before giving up. |
| Redeploy deadline / `NUCLIO_REDEPLOY_DEADLINE_MS` | `120000` | How long a redeploy may run before it's treated as failed. |
| Auto-redeploy on error / `NUCLIO_AUTO_REDEPLOY_ON_ERROR` | `false` | Also auto-redeploy functions in Nuclio's `error` state. |

The invoke node's per-call **Timeout** and **Concurrency Cap** are set on the `nuclio`
node itself (`NUCLIO_INVOCATION_TIMEOUT_MS` is the timeout fallback default).

## Hacks
[bug](https://github.com/nuclio/nuclio/issues/3968)
```bash
docker exec nuclio apk add --no-cache docker-cli-buildx
```