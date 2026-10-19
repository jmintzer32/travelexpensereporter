# Stage 1: build the Angular app
FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build -- --configuration=production

# Stage 2: a small Node server that serves the app and calls Claude
# (server/index.js). The Claude API key stays on the server: set
# ANTHROPIC_API_KEY on the Cloud Run service, from Secret Manager.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app/server

COPY server/package*.json ./
RUN npm ci --omit=dev

COPY server/ ./
COPY --from=build /app/dist /app/dist

# Cloud Run sends traffic to $PORT (8080 by default)
EXPOSE 8080
USER node
CMD ["node", "index.js"]
