#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/AI-Planning/planning-as-a-service.git"
REPO_DIR="planning-as-a-service"

if ! command -v git >/dev/null 2>&1; then
  echo "Error: git is not installed."
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: docker is not installed or not available in PATH."
  exit 1
fi

if [ ! -d "$REPO_DIR" ]; then
  echo "Cloning planning-as-a-service..."
  git clone "$REPO_URL"
else
  echo "Repository already exists. Pulling latest changes..."
  cd "$REPO_DIR"
  git pull
  cd ..
fi

echo "Building Docker image paas:latest..."
cd "$REPO_DIR/server"

DOCKER_DEFAULT_PLATFORM=linux/amd64 docker build -t paas:latest .

echo "Done. Docker image built as paas:latest"
