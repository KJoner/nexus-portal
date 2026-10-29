# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:22-alpine

# ── Build: web (Vite) + server (esbuild bundle) ─────────────────────────────
# The output is plain JS/CSS, so this stage always runs on the builder's native platform;
# multi-arch builds only repeat the small native-module stage below.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
COPY packages/shared/package.json packages/shared/
# No install scripts: nothing in the build needs them, and npm 10 would otherwise try to
# compile better-sqlite3 from source although it ships prebuilt binaries.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN npm run build

# ── Native modules (better-sqlite3, sharp) for the target platform ──────────
# Versions come from the lockfile. Both packages ship musl x64/arm64 binaries.
FROM ${NODE_IMAGE} AS native
WORKDIR /deps
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
COPY packages/shared/package.json packages/shared/
# The server bundle already contains every pure-JS dependency, so keep only the two native
# packages (and their own deps), and only this platform's binaries (sharp's WebAssembly
# fallback is never used when the native build loads).
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --workspace=@nexus/server --ignore-scripts --no-audit --no-fund \
 && cd node_modules \
 && rm -rf @nexus @hono hono zod hash-wasm @img/sharp-wasm32 @emnapi tslib better-sqlite3/deps better-sqlite3/src \
 && find . -maxdepth 1 -type d -empty -delete \
 && find better-sqlite3/prebuilds -type f ! -name "linuxmusl-$(node -p process.arch).node" -delete \
 && node -e "new (require('better-sqlite3'))(':memory:').close(); require('sharp')"

# ── Runtime ─────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
# The app never installs packages at runtime: drop the package managers (smaller image,
# fewer CVE reports to triage).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
 && mkdir -p /data && chown node:node /data
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    NEXUS_DATA_DIR=/data \
    NEXUS_WEB_DIST=/app/web
WORKDIR /app
COPY --from=native /deps/node_modules ./node_modules
COPY --from=build /src/apps/server/dist ./server
COPY --from=build /src/apps/web/dist ./web
# Last, so a new version number does not invalidate the layers above.
ARG NEXUS_VERSION=dev
ENV NEXUS_VERSION=${NEXUS_VERSION}
USER node
VOLUME ["/data"]
EXPOSE 8787
# While starting, check every 2 s (Docker ≥ 25; older engines ignore it), so deploy.sh and
# `compose up --wait` see "healthy" within seconds instead of after the first 30 s interval.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --start-interval=2s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/api/healthz >/dev/null || exit 1
CMD ["node", "--enable-source-maps", "server/index.mjs"]
