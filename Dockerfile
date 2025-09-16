# syntax=docker/dockerfile:1.7

FROM node:20-slim AS base
WORKDIR /app

# Backend deps
FROM base AS backend-deps
WORKDIR /app/backend
COPY backend/package.json ./
RUN npm install --omit=dev

# Frontend build
FROM base AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/vite.config.js frontend/index.html ./
RUN npm install
COPY frontend/src ./src
COPY frontend/public ./public
RUN npm run build

# Runtime
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=backend-deps /app/backend/node_modules ./backend/node_modules
COPY backend/package.json ./backend/package.json
COPY backend/app ./backend/app
COPY --from=frontend-build /app/frontend/dist ./backend/app/public

EXPOSE 8080
WORKDIR /app/backend
CMD ["node", "app/server.js"]


