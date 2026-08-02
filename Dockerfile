# Niche Finder OS — single-service production image.
# Serves the frontend, shared modules, and the /v1 API from one process.
FROM node:20-alpine
WORKDIR /app
COPY shared/ shared/
COPY frontend/ frontend/
COPY backend/gateway/ backend/gateway/
WORKDIR /app/backend/gateway
ENV NODE_ENV=production PORT=8080
# Persist /app/backend/gateway/data (wallet + leads) on a mounted volume.
EXPOSE 8080
CMD ["node", "src/server.js"]
