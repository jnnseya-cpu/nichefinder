# Niche Finder OS — single-service production image.
# One Node process serves the frontend, shared modules, and the /v1 API.
# Node 22 LTS — Node 20 is end-of-life and did not receive the 2026-10-21
# security fixes (incl. a high-severity RCE). The `22-alpine` tag tracks the
# latest patched 22.x (≥ 22.23.4), so a fresh build/pull always lands the fix.
FROM node:22-alpine
WORKDIR /app

# Static assets (no build step) — served by the gateway at /frontend and /shared.
COPY shared/ shared/
COPY frontend/ frontend/

# Install gateway dependencies first for Docker layer caching, then copy source.
# npm ci needs package-lock.json (present) and installs exactly the locked deps.
WORKDIR /app/backend/gateway
COPY backend/gateway/package.json backend/gateway/package-lock.json ./
RUN npm ci --omit=dev
COPY backend/gateway/ ./

ENV NODE_ENV=production PORT=8080
# Wallet + leads persist under ./data — mount a volume there (see DEPLOY-VPS.md).
EXPOSE 8080
CMD ["node", "src/server.js"]
