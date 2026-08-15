# Niche Finder OS — single-service production image.
# One Node process serves the frontend, shared modules, and the /v1 API.
FROM node:20-alpine
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
# Wallet + leads persist under ./data — mount a volume there (see render.yaml).
EXPOSE 8080
CMD ["node", "src/server.js"]
