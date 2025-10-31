# syntax=docker/dockerfile:1.7

FROM node:20-slim AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate

# Backend deps
FROM base AS backend-deps
WORKDIR /app/backend
COPY backend/package.json backend/pnpm-lock.yaml* ./
RUN pnpm install --prod --frozen-lockfile || pnpm install --prod

# Frontend build
FROM base AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/pnpm-lock.yaml* frontend/vite.config.js frontend/index.html ./
RUN pnpm install --frozen-lockfile || pnpm install
COPY frontend/src ./src
COPY frontend/public ./public
RUN pnpm run build

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


