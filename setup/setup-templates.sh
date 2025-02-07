#!/bin/bash

# Create ConfigMap for Kubernetes templates
kubectl create configmap k8s-templates \
  --namespace kube-system \
  --from-file=code-server-deployment.yaml=../deployments/code-server-deployment.yaml \
  --from-file=code-server-service.yaml=../deployments/code-server-service.yaml \
  --from-file=code-server-ingress.yaml=../deployments/code-server-ingress.yaml \
  --from-file=code-server-pvc.yaml=../deployments/code-server-pvc.yaml \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Kubernetes templates loaded successfully!"