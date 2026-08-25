# Kubernetes scale-to-zero reference

This is a complete Node-RED plus Nuclio scale-to-zero example. It deploys the
Nuclio Distributed Lazy Loading (DLX) component, enables the platform
scale-to-zero controller, deploys an ephemeral in-cluster registry for Kaniko,
and starts Node-RED with a function configured for `minReplicas: 0`.

Scale-to-zero is a Kubernetes/Nuclio platform feature. It is not available in
the local Docker Compose platform. The deployment-specific requirements are
captured in [`kustomization.yaml`](kustomization.yaml):

- DLX is enabled and uses the same pinned Nuclio image version as the
  controller and dashboard.
- `platform.scaleToZero.mode` is enabled.
- The function has an HTTP trigger, `minReplicas: 0`, and a positive maximum.
- The Node-RED invoke node supplies the `X-Nuclio-Target` header required for
  scale-from-zero routing.

The example needs an existing Kubernetes cluster, `kubectl`, Helm, Docker, and
KinD for the local image-loading example. The pinned images target amd64; for
an arm64 cluster, change the controller, dashboard, and DLX image tags
together. See the [Nuclio Kubernetes guide](https://docs.nuclio.io/en/latest/setup/k8s/running-in-production-k8s.html)
for the platform requirements.

## 1. Build the Node-RED image

Build the repository's current Node-RED image, then make it available to the
cluster. With KinD, for example:

```bash
docker build -t nodered-nuclio-reference:local .
kind load docker-image nodered-nuclio-reference:local
```

For another Kubernetes cluster, push the image to a registry and change the
image in `nodered-deployment.yaml`.

## 2. Deploy the complete example

```bash
kubectl kustomize --enable-helm examples/scale-to-zero/k8s | kubectl apply -f -
kubectl --namespace nuclio port-forward service/node-red-scale-to-zero 1880:1880
```

Open [Node-RED](http://localhost:1880), deploy the **Kubernetes scale-to-zero
example** flow, and click **Invoke scale-to-zero example** once to build and
start the function.

## 3. Force scale-to-zero and wake the function

For a deterministic demonstration, forward the Nuclio dashboard in a second
terminal and request the function's `scaledToZero` state:

```bash
kubectl --namespace nuclio port-forward service/nuclio-dashboard 8070:8070
curl -fsS -X PATCH http://127.0.0.1:8070/api/functions/example-scale-to-zero \
  -H 'x-nuclio-function-namespace: nuclio' \
  -H 'x-nuclio-project-name: example-scale-to-zero' \
  -H 'Content-Type: application/json' \
  --data '{"desiredState":"scaledToZero"}'
```

After the function reaches zero active replicas, click **Invoke scale-to-zero
example** again. The request should take longer while DLX starts the function,
then appear in the **Scale-from-zero response** debug output. The function
should return to `ready` with one active replica.

Remove the example with:

```bash
kubectl kustomize --enable-helm examples/scale-to-zero/k8s | kubectl delete -f -
```

This example is intentionally separate from the disposable maintainer canary
under [`hack/kind`](../../../hack/kind/), which automates the same lifecycle
and assertions.
