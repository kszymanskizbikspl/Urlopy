# Etap 1: zależności (kompilacja modułów natywnych: better-sqlite3, później argon2)
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci --omit=dev

# Etap 2: obraz docelowy bez kompilatorów
FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache tzdata
ENV NODE_ENV=production TZ=Europe/Warsaw PORT=3000 DATA_DIR=/app/data
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
COPY migrations ./migrations
COPY public ./public
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/api/health" || exit 1
CMD ["node", "src/server.js"]
