# KinD canary reference implementation

This example runs the disposable Kubernetes deployment path against a fresh
[KinD](https://kind.sigs.k8s.io/) cluster. It installs Nuclio with Helm,
builds a small prebuilt function image, loads it into the cluster, starts a
temporary Node-RED instance, and verifies an invocation through the Node-RED
Nuclio node.

From the repository root, the lifecycle is deliberately split into three
commands:

```bash
npm run test:kind -- up basic
npm run test:kind -- test-scenario basic
npm run test:kind -- down
```

`up` creates the cluster, installs Nuclio, builds and loads the static fixture
image, and starts Node-RED. `test-scenario` exercises the already-running
fixture. `down` stops local processes and removes the cluster. This makes the
fixture useful as a reference implementation as well as a disposable canary:
each stage can be inspected or rerun independently.

Keep the cluster and state directory for inspection with:

```bash
KIND_CANARY_KEEP_CLUSTER=1 npm run test:kind -- up basic
npm run test:kind -- test-scenario basic
npm run test:kind -- down
```

That final `down` removes the retained cluster. To leave it running, use
`KIND_CANARY_KEEP_CLUSTER=1` on the `down` command as well.

The autoscale and scale-to-zero scenarios use the same staged interface:

```bash
npm run test:kind -- up autoscale
npm run test:kind -- test-scenario autoscale
npm run test:kind -- down

npm run test:kind -- up scale-to-zero
npm run test:kind -- test-scenario scale-to-zero
npm run test:kind -- down
```

The no-argument form remains available for compatibility and runs the basic
scenario in one shot:

```bash
npm run test:kind
```

The fixture is environment-driven. `KIND_NODE_IMAGE`, `NUCLIO_VERSION`,
`NUCLIO_CHART_VERSION`, `CANARY_IMAGE`, replica bounds, ports, and scenario
settings can be overridden without generating files. The static flow uses
Node-RED environment typed properties and deployment variables; there are no
`.tmpl` files. The script is intentionally disposable and is not a production
Kubernetes installation recipe.
