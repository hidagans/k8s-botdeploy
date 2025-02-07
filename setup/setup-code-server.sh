#!/bin/bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Create bots namespace if it doesn't exist
kubectl create namespace bots 2>/dev/null || true

# Apply RBAC configuration
echo -e "${YELLOW}Setting up RBAC...${NC}"
kubectl apply -f code-server-rbac.yaml

# Apply storage configuration
echo -e "${YELLOW}Setting up storage...${NC}"
kubectl apply -f code-server-storage.yaml

# Create data directory on host
echo -e "${YELLOW}Creating data directory...${NC}"
sudo mkdir -p /data/code-server
sudo chmod 777 /data/code-server

# Apply Nginx configuration
echo -e "${YELLOW}Setting up Nginx configuration...${NC}"
kubectl apply -f code-server-nginx-config.yaml

# Check if TLS secret exists
if kubectl get secret code-server-tls -n bots >/dev/null 2>&1; then
  echo -e "${YELLOW}TLS secret already exists${NC}"
else
  echo -e "${YELLOW}Creating TLS secret...${NC}"
  kubectl apply -f code-server-tls-secret.yaml
fi

echo -e "${GREEN}Setup complete!${NC}"