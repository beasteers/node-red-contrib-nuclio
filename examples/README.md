# Runnable examples

These are repository-local demonstrations of the Node-RED/Nuclio message paths.
Each Compose scenario is independent and should be run one at a time because
the default host ports are shared.

The launcher detects `amd64` and `arm64` hosts and selects the matching Nuclio
dashboard image. Override `NUCLIO_ARCH` when cross-building.

## HTTP request/reply with Compose

The smallest example: Node-RED invokes a Python function over Nuclio's HTTP
endpoint and displays success and error paths.

```bash
bash examples/run-compose.sh http up -d
```

Open [Node-RED](http://localhost:1882), deploy the flow, and click **Invoke HTTP
example**. Stop it with `bash examples/run-compose.sh http down`.

### Kubernetes reference

The same HTTP path has a complete minimal Kubernetes reference under
[`http/k8s`](http/k8s/). One Kustomize build inflates the Nuclio and private
Docker Registry charts, then deploys the Node-RED Deployment, Service,
ConfigMaps, and example flow:

```bash
kubectl kustomize --enable-helm examples/http/k8s | kubectl apply -f -
kubectl --namespace nuclio port-forward service/node-red-http 1880:1880
```

See [`http/k8s/README.md`](http/k8s/README.md) for image and cleanup
instructions. This is intentionally separate from the disposable
[`hack/kind`](../hack/kind/) canary.

## Kubernetes scale-to-zero

Scale-to-zero requires Nuclio's Kubernetes DLX and scale-to-zero platform
components, so it has its own Kubernetes-only reference under
[`scale-to-zero/k8s`](scale-to-zero/k8s/):

```bash
kubectl kustomize --enable-helm examples/scale-to-zero/k8s | kubectl apply -f -
kubectl --namespace nuclio port-forward service/node-red-scale-to-zero 1880:1880
```

The example configures `minReplicas: 0`, demonstrates an explicit transition to
zero, and then invokes the function through Node-RED to demonstrate DLX
scale-from-zero recovery. See [`scale-to-zero/k8s/README.md`](scale-to-zero/k8s/README.md)
for the full walkthrough and cleanup command.

## Cron trigger

Nuclio owns a 30-second schedule. Node-RED owns the function declaration and
status view but does not send each invocation.

```bash
bash examples/run-compose.sh cron up -d
```

Open the function Status tab and refresh **Run logs**. Stop it with
`bash examples/run-compose.sh cron down`.

## Batching

This is an experimental Nuclio tech-preview feature. It is intended for Python
HTTP functions and requires the handler to return one response for each input
event.

Node-RED emits four messages. Nuclio's HTTP trigger waits for four messages or
one second, then invokes the function once with the batch.

```bash
bash examples/run-compose.sh batching up -d
```

Deploy the flow and click **Send four messages**. Stop it with
`bash examples/run-compose.sh batching down`.

## Direct MQTT trigger

This example runs Mosquitto and a native Nuclio MQTT trigger. Node-RED publishes
the input and observes the transformed output directly through MQTT; the
message does not pass through a Nuclio Invoke node.

```bash
bash examples/run-compose.sh mqtt up -d
```

Deploy the flow and click **Publish MQTT example event**. Stop it with
`bash examples/run-compose.sh mqtt down`.

## Native NATS Suite pipelines

The native NATS example installs `node-red-contrib-nats-suite` and demonstrates
common Node-RED/NATS pipelines alongside Nuclio: core pub/sub, native
request/reply, JetStream persistence and consumers, and KV-backed configuration.

```bash
bash examples/run-compose.sh nats up -d
```

Open [Node-RED](http://localhost:1882), deploy the flow, and use the inject
buttons. See [`nats/README.md`](nats/README.md) for the walkthrough.

Stop it with `bash examples/run-compose.sh nats down`.

## NATS MQTT bridge

Node-RED publishes through NATS's MQTT listener. The Nuclio NATS trigger
consumes the native subject, publishes a transformed result natively, and NATS
delivers that result back to Node-RED over MQTT.

```bash
bash examples/run-compose.sh nats-mqtt up -d
```

Deploy the flow and click **Publish NATS MQTT example event**. Stop it with
`bash examples/run-compose.sh nats-mqtt down`.

To run a focused example beside another stack, override its published ports:

```bash
NODE_RED_PORT=3882 NUCLIO_PORT=3872 bash examples/run-compose.sh http up -d
```

The Compose examples use local, unauthenticated dashboards and are intended for
development and demonstration only. Batching, MQTT, and NATS triggers are
Nuclio tech-preview features in the referenced Nuclio release.

The disposable Kubernetes canary is maintainer tooling, not a user example. See
[`hack/kind/README.md`](../hack/kind/README.md).
