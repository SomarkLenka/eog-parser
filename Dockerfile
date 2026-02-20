FROM node:22-bookworm-slim

# Install system dependencies (includes build tools for fallback)
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
    ca-certificates \
    build-essential \
    python3 \
    git \
    && rm -rf /var/lib/apt/lists/*

# Set up pnpm global directory
ENV PNPM_HOME="/root/.local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

# Enable corepack for pnpm and set up global directory
RUN corepack enable && \
    corepack prepare pnpm@latest --activate && \
    mkdir -p $PNPM_HOME

# Hybrid OpenClaw installation:
# 1. Try pnpm global install (fast)
# 2. If fails, build from source (reliable)
RUN pnpm add -g openclaw@latest || ( \
    echo ">>> pnpm install failed, building from source..." && \
    cd /tmp && \
    git clone --depth 1 https://github.com/openclaw/openclaw.git && \
    cd openclaw && \
    pnpm install --frozen-lockfile && \
    pnpm build && \
    (pnpm ui:build || true) && \
    pnpm link --global && \
    cd / && \
    rm -rf /tmp/openclaw \
)

# Verify OpenClaw installed successfully
RUN openclaw --version || (echo "OpenClaw installation failed!" && exit 1)

# Create app directory
WORKDIR /app

# Copy package files and install deps
COPY package*.json ./
RUN npm install --production

# Copy application code
COPY . .

# Copy test PDF for dev mode
COPY test.pdf /app/test.pdf

# Create directories for OpenClaw and app data
RUN mkdir -p /data/.openclaw /data/workspace /data/uploads /data/output

# Environment
ENV NODE_ENV=production
ENV OPENCLAW_STATE_DIR=/data/.openclaw
ENV OPENCLAW_WORKSPACE_DIR=/data/workspace
ENV PORT=8080
ENV NODE_OPTIONS="--max-old-space-size=1024"

# Expose port
EXPOSE 8080

# Start script handles both OpenClaw gateway and Express server
CMD ["node", "start.js"]
