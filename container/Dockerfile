FROM node:22-slim

# System tools for building and snapshot management
RUN apt-get update && apt-get install -y \
    git curl jq zstd \
    && rm -rf /var/lib/apt/lists/*

# Container agent
WORKDIR /opt/agent
COPY agent.mjs ./
COPY package.json ./

# Workspace and local directories
RUN mkdir -p /workspace /local /mnt/workspace

EXPOSE 8080
ENTRYPOINT ["node", "/opt/agent/agent.mjs"]
