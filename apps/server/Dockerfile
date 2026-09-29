# syntax=docker/dockerfile:1
#
# CLA-266 atlas API container: apps/server in OKIE_SERVER_MODE=public-readonly behind the sourcefor.dev edge Worker.
# Build context = the repo root (the root .dockerignore is an allowlist):
#   docker buildx build --platform linux/amd64 -f apps/server/Dockerfile -t okie-atlas-api .
# Scans never run here: no git, no Rust toolchain, no fixtures, no .env, no secrets baked in. The gateway key and
# other secrets arrive as container env at runtime; published atlases are mirrored from OKIE_PUBLISHED_STORE_URL.

# The build stage runs on the BUILD platform: it only runs pnpm and tsc (pure JS), and node under qemu amd64 emulation
# on an arm64 host aborts in libuv (uv__io_poll). No prod dependency has a platform-specific optional package, and
# tree-sitter / tree-sitter-rust ship prebuilds for every platform (node-gyp-build picks linux-x64 at runtime).
FROM --platform=$BUILDPLATFORM node:22-slim AS build
ENV CI=true PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@11.10.0 --activate
WORKDIR /repo

# Manifests first so the dependency layer caches across source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/architecture/package.json packages/architecture/
COPY packages/scene-compiler/package.json packages/scene-compiler/
COPY packages/scan/package.json packages/scan/
COPY apps/server/package.json apps/server/
# Only @okie/server and its workspace dependency closure; no compiler toolchain is needed (prebuilt natives).
RUN pnpm install --frozen-lockfile --filter "@okie/server..."

COPY packages/architecture packages/architecture
COPY packages/scene-compiler packages/scene-compiler
COPY packages/scan packages/scan
COPY apps/server apps/server
RUN pnpm --filter "@okie/server..." run build \
  && pnpm --filter @okie/server deploy --prod --legacy /out \
  && rm -rf /out/src /out/Dockerfile /out/tsconfig.json /out/tsconfig.tsbuildinfo /out/dist/*.test.* /out/dist/*.fixture.*

# Cloudflare Containers run linux/amd64.
FROM --platform=linux/amd64 node:22-slim AS runtime
# Memory defaults sized for a 1 GiB (`basic`) instance: measured peak RSS ~0.5 GB (main + Ask worker) with three
# published atlases warm (18 MB, 1.6 MB and 4 KB snapshots). Raise them on a larger instance.
ENV NODE_ENV=production \
    OKIE_SERVER_MODE=public-readonly \
    OKIE_SERVER_HOST=0.0.0.0 \
    OKIE_SERVER_PORT=8080 \
    OKIE_TRUSTED_PROXY=cloudflare \
    OKIE_ASK_WORKER_MAX_HEAP_MB=512 \
    OKIE_ASK_MAX_WARM_INDEXES=2 \
    OKIE_NEIGHBORHOOD_CACHE_ENTRIES=2
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
