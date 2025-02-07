#!/bin/bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Create bots namespace if it doesn't exist
echo -e "${YELLOW}Creating bots namespace...${NC}"
kubectl create namespace bots 2>/dev/null || true

# Apply RBAC configuration
echo -e "${YELLOW}Setting up RBAC...${NC}"
kubectl apply -f code-server-rbac.yaml
kubectl wait --for=condition=established --timeout=60s crd/clusterissuers.cert-manager.io

# Create data directory on host
echo -e "${YELLOW}Creating data directory...${NC}"
sudo mkdir -p /data/code-server
sudo chmod 777 /data/code-server

# Apply storage configuration
echo -e "${YELLOW}Setting up storage...${NC}"
kubectl apply -f code-server-storage.yaml

# Apply Nginx configuration
echo -e "${YELLOW}Setting up Nginx configuration...${NC}"
kubectl apply -f code-server-nginx-config.yaml

# Install cert-manager
echo -e "${YELLOW}Installing cert-manager...${NC}"
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.13.3/cert-manager.yaml

# Wait for cert-manager to be ready
echo -e "${YELLOW}Waiting for cert-manager to be ready...${NC}"
kubectl wait --for=condition=ready pod -l app.kubernetes.io/instance=cert-manager -n cert-manager --timeout=300s

# Create ClusterIssuer
echo -e "${YELLOW}Creating ClusterIssuer...${NC}"
kubectl apply -f cert-manager-issuer.yaml

# Create service account token
echo -e "${YELLOW}Creating service account token...${NC}"
kubectl create token code-server -n bots

echo -e "${GREEN}Setup complete!${NC}"
echo -e "Please wait a few minutes for the certificate to be issued."