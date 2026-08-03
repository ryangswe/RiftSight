# Production image for relay/ — the RiftSight backend. Built from the
# monorepo root (not relay/ alone), because relay/ depends on the
# @riftsight/protocol workspace package via npm workspaces symlinking —
# `npm ci` needs every workspace's package.json present to resolve the
# workspace graph correctly against the committed package-lock.json.
#
# Runs the same way `npm run start -w relay` does locally: via tsx,
# directly from TypeScript source, no separate compile step — relay/ has
# never had one (see README's "Commands" section: "protocol/relay/
# overlay-core have no build step — they run from source"). This is why
# `npm ci` below is NOT run with --omit=dev: tsx is a root devDependency,
# but it's what actually executes the server at runtime here, not just a
# local dev convenience.
#
# Deliberately Node 20 (current LTS), not this repo's dev-sandbox-pinned
# Node 16.13.2 (see README's "Known limitations" — that pin is a
# constraint of the environment this project happened to be built in, not
# a requirement the production image needs to match). Node 16 is EOL and
# shouldn't run a real deployment.
FROM node:20-alpine

WORKDIR /app

# Every workspace's package.json first, for both npm ci's workspace
# resolution and Docker layer caching — dependencies are only reinstalled
# when one of these actually changes, not on every source edit below.
COPY package.json package-lock.json ./
COPY protocol/package.json protocol/package.json
COPY relay/package.json relay/package.json
COPY overlay-core/package.json overlay-core/package.json
COPY extension/package.json extension/package.json
COPY debug-viewer/package.json debug-viewer/package.json
COPY twitch-extension/package.json twitch-extension/package.json

RUN npm ci

# Only what relay/ actually needs at runtime: itself, its migrations/
# scripts, and the one workspace package it imports from. The other
# workspaces' source (extension/, twitch-extension/, debug-viewer/,
# overlay-core/'s own src) is never copied — their package.json above was
# only needed to satisfy npm's workspace graph, nothing else about them
# ships in this image.
COPY protocol/src protocol/src
COPY relay/src relay/src
COPY relay/scripts relay/scripts

# The port the app actually binds is controlled by PORT/RELAY_PORT (see
# relay/src/env.ts) — this is documentation for anyone reading the
# Dockerfile, not something Docker enforces on its own.
EXPOSE 8787

CMD ["npx", "tsx", "relay/src/index.ts"]
