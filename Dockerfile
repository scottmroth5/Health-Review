# Health Review server image: Node 22 and the app's code, adapted from Job Agent's. Holds code only. Health data,
# .env, the Google sign-in files and the MAPS catalog never enter the image: .dockerignore keeps them out, the data
# folder is mounted at /app/data, and settings come from an env file at run time. One image serves both containers:
# the app (AUTH_MODE=google) and the public demo (AUTH_MODE=demo, made-up data built at start, no env file).
#
#   docker build -t health-review .
#   docker run --env-file .env -e HOST=0.0.0.0 -v "$PWD/data:/app/data" -p 127.0.0.1:5188:5188 health-review
#
# Layers are ordered so a code change rebuilds only the last one: production dependencies are reused until
# package-lock.json changes.

# Tools for installing dependencies. git: agent-core is a public GitHub dependency (no token). python3, make, g++: the
# fallback if better-sqlite3 has no prebuilt binary for this platform.
FROM node:22-bookworm-slim AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
# Production dependencies only: what the server runs with. (prepare does nothing without a .git folder.)
RUN npm ci --omit=dev && rm -rf /root/.npm

# The country database for US-only access (server/geo.js): DB-IP's free IP to Country Lite (CC BY 4.0,
# https://db-ip.com), this month's file or last month's. A failed download leaves no file, and the app then blocks
# nothing and emails the administrator; the weekly rebuild tries again.
FROM debian:bookworm-slim AS geo
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# GEO_STAMP (the build date, from the deploy workflow) makes each build download the file afresh rather than reuse the cache.
ARG GEO_STAMP=none
RUN echo "country database for build $GEO_STAMP" && mkdir -p /geo \
 && for m in "$(date -u +%Y-%m)" "$(date -u -d "$(date -u +%Y-%m-01) -1 month" +%Y-%m)"; do \
      if curl -fsSL --max-time 120 -o /tmp/country.mmdb.gz "https://download.db-ip.com/free/dbip-country-lite-$m.mmdb.gz" \
         && gunzip -c /tmp/country.mmdb.gz > /geo/country.mmdb && [ -s /geo/country.mmdb ]; then echo "country database $m"; break; fi; \
      rm -f /geo/country.mmdb; \
    done; rm -f /tmp/country.mmdb.gz; true

# Runtime: the same Debian and Node as above, so the native module built there loads here unchanged.
FROM node:22-bookworm-slim
# tzdata so TZ resolves; the app itself uses OWNER_TZ for every date and does not depend on TZ. The npm, yarn and corepack
# tools that come with the Node image are removed: the server only ever runs node, and they carry their own
# dependencies (and their vulnerabilities, which the image scan in deploy.yml would otherwise flag).
RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    HOST=0.0.0.0 \
    PORT=5188 \
    TZ=America/New_York \
    OWNER_TZ=America/New_York
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=geo /geo /app/geo
COPY . .
# Runs as the unprivileged node user (uid 1000); the mounted /app/data folder must be owned by that uid.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 5188
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5188)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
