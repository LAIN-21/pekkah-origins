# syntax=docker/dockerfile:1
# One image definition for every Node app. Targets: market (also builds
# apps/web), facilitator, agent, worker. Apps run with tsx through their
# `start` script; there is no build step for them.
#
#   docker build --target market --build-arg GIT_SHA=$(git rev-parse HEAD) .

FROM node:22-bookworm-slim AS base
WORKDIR /app
# `pnpm start` must not try to reinstall node_modules at runtime (it is
# read-only for the node user). pnpm ≥ 11 reads pnpm_config_*, older npm_config_*.
ENV CI=true \
    pnpm_config_verify_deps_before_run=false \
    npm_config_verify_deps_before_run=false
# The pnpm version follows package.json's packageManager when it has one.
ARG PNPM_VERSION=12.9.1
COPY package.json ./
RUN v=$(node -p "((require('./package.json').packageManager || '').split('@')[1] || '').split('+')[0]") \
 && npm install -g "pnpm@${v:-$PNPM_VERSION}" \
 && pnpm --version

FROM base AS source
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store pnpm fetch --store-dir /pnpm-store
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm install --offline --frozen-lockfile --store-dir /pnpm-store

FROM source AS market
RUN if [ -f apps/web/package.json ]; then pnpm --dir apps/web run build; fi
RUN mkdir -p /var/lib/pekkah && chown node:node /var/lib/pekkah
ARG GIT_SHA=unknown
ENV NODE_ENV=production GIT_SHA=${GIT_SHA}
LABEL org.opencontainers.image.revision=${GIT_SHA}
USER node
WORKDIR /app/apps/market
EXPOSE 8080
CMD ["pnpm", "start"]

FROM source AS facilitator
ARG GIT_SHA=unknown
ENV NODE_ENV=production GIT_SHA=${GIT_SHA}
LABEL org.opencontainers.image.revision=${GIT_SHA}
USER node
WORKDIR /app/apps/facilitator
EXPOSE 4022
CMD ["pnpm", "start"]

FROM source AS agent
ARG GIT_SHA=unknown
ENV NODE_ENV=production GIT_SHA=${GIT_SHA}
LABEL org.opencontainers.image.revision=${GIT_SHA}
USER node
WORKDIR /app/apps/agent
EXPOSE 4100
CMD ["pnpm", "start"]

# Runs as root: it drives the host's Docker through the mounted socket.
FROM source AS worker
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker
ARG GIT_SHA=unknown
ENV NODE_ENV=production GIT_SHA=${GIT_SHA}
LABEL org.opencontainers.image.revision=${GIT_SHA}
WORKDIR /app/apps/worker
CMD ["pnpm", "start"]
