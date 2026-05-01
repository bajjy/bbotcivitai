# syntax=docker/dockerfile:1.7

# ---- Stage 1: install production dependencies ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund

# ---- Stage 2: runtime ----
FROM node:20-alpine AS runtime
WORKDIR /app

# Run as non-root
RUN addgroup -S bbot && adduser -S bbot -G bbot

ENV NODE_ENV=production \
    PHOTO_HOST_PORT=8088

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY bot.mjs ./
COPY config ./config
COPY services ./services
COPY utils ./utils

# temp/ is created at runtime by utils/paths.mjs, but we need write perms
RUN mkdir -p /app/temp && chown -R bbot:bbot /app

USER bbot
EXPOSE 8088

# Tiny healthcheck against the photoHost /healthz endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PHOTO_HOST_PORT+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "bot.mjs"]
