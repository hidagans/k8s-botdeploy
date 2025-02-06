#!/bin/bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Function to check if command exists
command_exists() {
  command -v "$1" >/dev/null 2>&1
}

# Function to install dependencies
install_dependencies() {
  echo -e "${YELLOW}Installing dependencies...${NC}"
  apt-get update && apt-get install -y \
    curl \
    sudo \
    nfs-common \
    open-iscsi \
    jq \
    net-tools
}

# Function to setup firewall rules
setup_firewall() {
  echo -e "${YELLOW}Setting up firewall rules...${NC}"
  if command_exists ufw; then
    ufw allow 6443/tcp  # Kubernetes API
    ufw allow 8472/udp  # VXLAN (Flannel)
    ufw allow 10250/tcp # Kubelet
    ufw allow 2379/tcp  # etcd
    ufw allow 2380/tcp  # etcd peer
    ufw allow 10257/tcp # kube-controller
    ufw allow 10259/tcp # kube-scheduler
  fi
}

# Function to setup master node
setup_master() {
  echo -e "${GREEN}Setting up Kubernetes Master Node...${NC}"
  
  # Install k3s as master
  curl -sfL https://get.k3s.io | sh -s - server \
    --disable traefik \
    --disable servicelb \
    --disable local-storage \
    --disable metrics-server \
    --flannel-backend=vxlan \
    --node-taint CriticalAddonsOnly=true:NoExecute \
    --write-kubeconfig-mode 644

  # Wait for k3s to be ready
  sleep 10

  # Get node token
  NODE_TOKEN=$(cat /var/lib/rancher/k3s/server/node-token)
  echo -e "\n${YELLOW}Node Token:${NC}"
  echo $NODE_TOKEN

  # Get master IP
  MASTER_IP=$(hostname -I | awk '{print $1}')
  echo -e "\n${YELLOW}Master IP:${NC}"
  echo $MASTER_IP

  # Save master info
  echo "MASTER_IP=$MASTER_IP" > /root/k3s-master.info
  echo "NODE_TOKEN=$NODE_TOKEN" >> /root/k3s-master.info
  chmod 600 /root/k3s-master.info

  # Install MetalLB
  kubectl apply -f https://raw.githubusercontent.com/metallb/metallb/v0.13.12/config/manifests/metallb-native.yaml

  # Wait for MetalLB to be ready
  echo -e "\n${YELLOW}Waiting for MetalLB to be ready...${NC}"
  kubectl wait --namespace metallb-system \
    --for=condition=ready pod \
    --selector=app=metallb \
    --timeout=90s

  # Create MetalLB configuration
  cat <<EOF | kubectl apply -f -
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: first-pool
  namespace: metallb-system
spec:
  addresses:
  - ${MASTER_IP%.*}.240-${MASTER_IP%.*}.250
---
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: l2-advert
  namespace: metallb-system
spec:
  ipAddressPools:
  - first-pool
EOF

  # Install Nginx Ingress Controller
  kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.8.2/deploy/static/provider/cloud/deploy.yaml

  # Create namespace for bots
  kubectl create namespace bots

  echo -e "\n${GREEN}Master node setup complete!${NC}"
  echo -e "\nTo join worker nodes, run this command on each worker:"
  echo -e "${YELLOW}curl -sfL https://get.k3s.io | K3S_URL=https://${MASTER_IP}:6443 K3S_TOKEN=${NODE_TOKEN} sh -${NC}"
}

# Function to setup worker node
setup_worker() {
  if [ -z "$1" ] || [ -z "$2" ]; then
    echo -e "${RED}Usage: $0 worker <master_ip> <node_token>${NC}"
    exit 1
  fi

  MASTER_IP=$1
  NODE_TOKEN=$2

  echo -e "${GREEN}Setting up Kubernetes Worker Node...${NC}"
  
  # Install k3s as worker
  curl -sfL https://get.k3s.io | K3S_URL=https://${MASTER_IP}:6443 K3S_TOKEN=${NODE_TOKEN} sh -

  echo -e "\n${GREEN}Worker node setup complete!${NC}"
}

# Main script
if [ "$EUID" -ne 0 ]; then 
  echo -e "${RED}Please run as root${NC}"
  exit 1
fi

# Install dependencies
install_dependencies

# Setup firewall
setup_firewall

# Check command line arguments
if [ "$1" = "master" ]; then
  setup_master
elif [ "$1" = "worker" ]; then
  setup_worker "$2" "$3"
else
  echo -e "${RED}Usage: $0 [master|worker] [master_ip node_token]${NC}"
  exit 1
fi