# kb (kbkan) — local markdown kanban CLI + web UI.
#
#   docker build -t kb .
#   docker run --rm -p 4747:4747 -v "$PWD/board:/data" kb
#
# /data IS THE BOARD DIRECTORY, not scratch space. `kb` reads kanban.yaml from the
# process CWD and scans the ticket .md files that sit next to it, so the runtime
# stage ends with WORKDIR /data and expects a board mounted there:
#
#   /data/kanban.yaml   board config (`kb init` writes a starter one)
#   /data/*.md          the tickets (glob-configurable)
#   /data/.kb/          event + automation logs, created on demand
#
# `kb web` refuses to start when that config is missing, so mount a directory that
# already has kanban.yaml (or create one first: `docker run --rm -v "$PWD/board:/data" kb kb init`).
# The application itself lives in /app; only dist/, package.json and the
# production node_modules are shipped.
#
# No secret is needed to build this image.

FROM node:22-slim AS base
# npm only runs at build time; keep its output and update chatter out of the logs.
ENV npm_config_fund=false \
    npm_config_audit=false \
    npm_config_update_notifier=false
WORKDIR /app

# ---- build: dev deps + sources -> dist/ (JS + the copied web UI assets) ----
FROM base AS build
# --ignore-scripts: the repo's `prepare` hook installs husky git hooks, which have
# no place in an image build (and `.husky` is not even in the build context).
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
# `npm run build` = tsc plus a copy of src/web/public -> dist/web/public. Those
# assets MUST be in dist/ or every page/asset request 404s at run time.
RUN npm run build

# ---- prod-deps: production-only dependency tree (commander, yaml, zod) ----
FROM base AS prod-deps
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev

# ---- runtime ----
FROM node:22-slim AS runtime
LABEL org.opencontainers.image.title="kb" \
      org.opencontainers.image.description="Local markdown kanban CLI and web UI: tickets are plain .md files, the board is kanban.yaml." \
      org.opencontainers.image.source="https://github.com/hampusadamsson/kb" \
      org.opencontainers.image.url="https://github.com/hampusadamsson/kb" \
      org.opencontainers.image.documentation="https://github.com/hampusadamsson/kb#readme" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# dist/version.js imports ../package.json, so package.json must sit beside dist/.
COPY --from=build /app/package.json ./package.json
# The published bin is dist/cli/main.js; expose it as `kb` (and keep the exec bit,
# which a COPY does not guarantee). Project files stay root-owned/read-only.
RUN chmod 0755 dist/cli/main.js \
  && ln -s /app/dist/cli/main.js /usr/local/bin/kb

# Unprivileged uid (10001) so a mounted board stays owned by the host user rather
# than by root; /data is pre-created writable for the case where nothing is mounted.
RUN useradd --create-home --uid 10001 --user-group kb \
  && mkdir -p /data \
  && chown kb:kb /data
WORKDIR /data
USER kb

# Deterministic port: the flags below pin it, so EXPOSE/HEALTHCHECK can rely on it.
EXPOSE 4747
# GET /api/health returns 200 {"ok":true} once the server is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4747/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# --host 0.0.0.0: the default 127.0.0.1 is unreachable through a published port.
# --port 4747:   wins over web.port in kanban.yaml, so EXPOSE stays truthful.
# --no-open:     no browser to launch in a container.
# The entry point is spelled ABSOLUTELY (/app/dist/cli/main.js): CWD must be the
# board dir (/data), and node resolves a relative script path against the CWD.
CMD ["node", "/app/dist/cli/main.js", "web", "--host", "0.0.0.0", "--port", "4747", "--no-open"]
