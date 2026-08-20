# Deploy Nuclio Functions with Node-Red.

Deploy Nuclio Functions directly from a Node-Red script. These are essentially Python, Go, Node.js, or Shell HTTP endpoints that nodered calls.

The **nuclio-function** config node acts essentially like a function node, giving you a
code editor. Once it is deployed, it deploys the function to Nuclio and keeps it healthy.
The **nuclio** node then acts as an HTTP request node, making requests to that function.

> NOTE: The function editor supports online source code, container images, Git repositories, and archive URLs. The selected source fields take precedence over matching fields in the advanced function configuration. Repository downloads are performed by the Nuclio builder, so the builder must be able to reach the repository.

## Install

> This project is under active development — I look forward to hearing your experience, feedback, and ideas for improvements.

```bash
npm i @bea.steers/node-red-contrib-nuclio
```

Runtime requirements are Node.js **22 or newer** and Node-RED **4.0.0 or newer**.
The test matrix covers Node.js 22/26 with Node-RED 4.0.0/5.0.4.

In order to use this node, you must have the Nuclio dashboard running. It doesn't need to be public, it just needs to be accessible by Node-Red.

Using the Docker Compose test install below will give you a fully functioning system to experiment with. It is a development fixture, not required by an installed package.

## Test Install
To test/develop
```bash
docker compose up -d --build
```
Unit tests and lint:
```bash
npm test
npm run lint
```
Smoke test (from a repository checkout; spins up Docker Compose, deploys a real Nuclio function, and invokes it):
```bash
npm run smoke
```
Redeploy diagnostic (snapshots Docker, Nuclio, Node-RED, and in-network probes before
and after a targeted redeploy):
```bash
node scripts/diagnose-redeploy.js --function dewlit-logic --duration 90
```
The script discovers the Node-RED function node, triggers its normal redeploy route,
prints state changes, and writes a JSON timeline. Use `--rebuild` to test a rebuild,
`--node-id <id>` when flow discovery is unavailable, or `--report <path>` to choose
the report location. It requires the running `nodered-nuclio`, `nuclio`, and function
containers to be reachable through Docker.
The smoke test and redeploy diagnostic are repository-development tools; the published
package contains their scripts but does not include this Compose fixture.
You can access: 
 * Node-Red dashboard [here](http://localhost:1882). 
 * The Nuclio dashboard can be found [here](http://localhost:8072).

## Tuning

Cadence and self-healing behavior is configurable **in the node editor** — connection
and polling cadence on the **Nuclio Server** config node, recovery policy on the
**Nuclio Function** node. Each field resolves:

> node config (numeric literal or typed value)
> → the built-in default.

Editing a field takes effect on the next **Deploy** — no Node-RED restart. Blank fields
use the built-in defaults. Typed values such as `env` can be used when a deployment
should read from Node-RED's environment.

**Server node (per dashboard):**

| Field | Default | Purpose |
| --- | --- | --- |
| Invocation endpoint source | `service` | Choose a stable service hostname, a Nuclio-reported internal URL, or a Nuclio-reported external URL. |
| Stable service hostname template | `nuclio-{function}` | Leave blank for the Kubernetes default. Docker Compose commonly uses `nuclio-nuclio-{function}`. |
| External URL protocol | `https` | Scheme for scheme-less external URLs. Explicit `http://` or `https://` URLs are preserved. |
| Poll interval | `1000` | Poll interval while a function is building/transitioning. |
| Ready poll | `5000` | Poll interval once a function is healthy. |
| Backoff | `5000` | First retry delay after a dashboard error (doubles each failure). |
| Backoff max | `60000` | Cap on the exponential backoff. |
| Start stagger | `2000` | Window to spread first-deploys across on startup. |
| Request timeout | `10000` | Status/admin HTTP timeout. |
| Deploy timeout | `60000` | Create/update HTTP timeout. |

**Function node (per function):**

| Field | Default | Purpose |
| --- | --- | --- |
| Self-heal attempts | `5` | Auto-redeploys of an unhealthy function before giving up. |
| Redeploy deadline | `120000` | How long a redeploy may run before it's treated as failed. |
| Auto-redeploy on error | `false` | Also auto-redeploy functions in Nuclio's `error` state. |

The invoke node's per-call **Timeout**, **Concurrency Cap**, **Retries**, and **Retry
Delay** are set on the `nuclio` node itself. Each can use a numeric literal, the built-in
default, or a typed environment value.

Transient failures — connection errors and `429`/`502`/`503`/`504` responses (a function
scaling or redeploying) — only log a warning (they never trigger Catch nodes), and are
retried with exponential backoff when **Retries** > 0, honoring a numeric `Retry-After`
header. Retries are at-least-once: a dropped connection may still have delivered the
request, so make side-effecting functions idempotent if you enable retries.

## How deploy & health work

**Change detection is hash-based.** Each deploy stamps the function with a fingerprint
(`nuclio.io/node-red-config-hash`, plus a build-only hash) as annotations. On the next
deploy, node-red compares fingerprints instead of deep-diffing the live config, so
server-side defaults never cause churn. If only non-build inputs changed (env, replicas,
...), the update is pushed with `skip-build` and no image rebuild. Functions deployed by
older versions are migrated on their first update. Note: edits made **directly in the
Nuclio dashboard** are not reverted while the fingerprint matches — node-red reasserts
your config the next time it actually changes.

**Rebuild vs. redeploy.** The status tab's **Redeploy** re-converges the function from
its existing image (fast, no build). **Rebuild** forces a full image rebuild even when
the config is unchanged. For `git`/`archive` code entries, that is how you pick
up new commits behind an unchanged URL — the fingerprint covers your config, not the
repo's contents, so a plain redeploy would reuse the old image.

**Health is a two-party split.** Nuclio is the *sensor* — it watches container health and
reports function state, but does not redeploy. Node-RED is the *actuator* — the reconcile
loop reads state and is the only thing that redeploys (self-heal). They don't fight; the
guards below keep node-red from reacting to flaky verdicts:

 * Status is always polled (at the **Ready poll** cadence when healthy). Succeeding
   invocations never skip observation — they only slow the poll and suppress self-heal.
 * An invocation success only counts while **fresh** (~30s), so an idle function that
   served one request an hour ago is still watched.
 * Self-heal waits for **two consecutive** unhealthy readings before redeploying, so a
   single flaky health verdict doesn't churn a redeploy. Self-heal remains bounded by
   **Self-heal attempts**, then gives up with an honest status.

## Nuclio compatibility

All dashboard interaction is isolated in `lib/nuclio-client.js` (endpoints, headers,
and request shapes); state names are isolated in `lib/nuclio-states.js`. The Compose
fixture uses dashboard **1.17.5-arm64** by default. Set `NUCLIO_DASHBOARD_IMAGE`
and `NUCLIO_ARCH` when running it on another architecture. State handling is open-world: node-red
acts on the small known set (`ready`, `error`, `unhealthy`, `scaledToZero`, 404) and
treats any other state as "in transition — show it and wait," so unknown future states
degrade to observation rather than breakage. If a Nuclio release changes the API, that
one file is where to look.

## Migrating from 1.0

Since 1.1 the function configuration (code, runtime, env) lives on a shared
`nuclio-function` config node instead of the invoke node, so several invoke nodes (or
subflows) can share one function. To convert a pre-1.1 `flows.json`:

```bash
node scripts/migrate-nuclio-config.js path/to/flows.json            # writes flows.migrated.json
node scripts/migrate-nuclio-config.js path/to/flows.json --in-place # or overwrite
```

## Hacks
[bug](https://github.com/nuclio/nuclio/issues/3968)
```bash
docker exec nuclio apk add --no-cache docker-cli-buildx
```
