# Kubernetes HTTP reference

This is a complete, minimal Node-RED plus Nuclio example. Kustomize inflates
the Nuclio and Docker Registry Helm charts, then deploys Node-RED with the
example flow and settings. The registry is private to the `nuclio` namespace
and exists only to support Nuclio's in-cluster Kaniko builds.

The example needs an existing Kubernetes cluster, `kubectl`, Helm, Docker, and
KinD for the local image-loading example. See the [Nuclio
Kubernetes guide](https://docs.nuclio.io/en/latest/setup/k8s/running-in-production-k8s.html)
for the underlying Kaniko and registry model.

## 1. Build the Node-RED image

Build the repository's current Node-RED image, then make it available to the
cluster. With KinD, for example:

```bash
docker build -t nodered-nuclio-reference:local .
kind load docker-image nodered-nuclio-reference:local
```

For another Kubernetes cluster, push the image to a registry and change the
image in `nodered-deployment.yaml`. The reference keeps this image local so
the complete demo stays independent of registry credentials.

## 2. Deploy the complete example

`helmCharts` runs Helm during the Kustomize build. The explicit
`--enable-helm` flag makes that dependency visible:

```bash
kubectl kustomize --enable-helm examples/http/k8s | kubectl apply -f -
kubectl --namespace nuclio port-forward service/node-red-http 1880:1880
```

Open [Node-RED](http://localhost:1880), deploy the **Kubernetes HTTP example**
flow, and click **Invoke HTTP example**. The response appears in the debug
sidebar.

Remove it with:

```bash
kubectl kustomize --enable-helm examples/http/k8s | kubectl delete -f -
```

This example does not create a Kubernetes cluster or run stress and
autoscaling scenarios. Those are separate concerns covered by the
maintainer-only [`hack/kind`](../../../hack/kind/) canary.
