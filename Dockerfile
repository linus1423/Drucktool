# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-alpine AS runtime
# Setzt die CI (git describe bzw. Commit); sichtbar unter /api/health und für Admins in der Fußzeile.
ARG APP_VERSION=dev
ARG GIT_COMMIT=unknown
LABEL org.opencontainers.image.version=$APP_VERSION \
      org.opencontainers.image.revision=$GIT_COMMIT
ENV NODE_ENV=production \
    APP_VERSION=$APP_VERSION \
    GIT_COMMIT=$GIT_COMMIT \
    PORT=3000 \
    HOST=0.0.0.0 \
    MIGRATIONS_DIR=/app/drizzle \
    UPLOAD_DIR=/app/uploads
WORKDIR /app
# Nitro bündelt alle Abhängigkeiten, node_modules wird zur Laufzeit nicht gebraucht.
COPY --from=build --chown=node:node /app/.output ./.output
COPY --from=build --chown=node:node /app/drizzle ./drizzle
COPY --chown=node:node docker/entrypoint.sh ./entrypoint.sh
# Hochgeladene Druckdateien; im Betrieb als Volume eingebunden.
RUN mkdir -p /app/uploads && chown node:node /app/uploads
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
ENTRYPOINT ["./entrypoint.sh"]
