# Health Review server image: Node 26 and the app's code, adapted from Job Agent's. Holds code only. Health data,
# .env, the Google sign-in files and the MAPS catalog never enter the image: .dockerignore keeps them out, the data
# folder is mounted at /app/data, and settings come from an env file at run time. One image serves both containers:
# the app (AUTH_MODE=google) and the public demo (AUTH_MODE=demo, made-up data built at start, no env file).
#
#   docker build -t health-review .
#   docker run --env-file .env -e HOST=0.0.0.0 -v "$PWD/data:/app/data" -p 127.0.0.1:5188:5188 health-review
#
# Layers are ordered so a code change rebuilds only the last one: production dependencies are reused until
# package-lock.json changes.
#
# Two targets (v3 Phase 1G): the default is the app (and demo) image; --target backup adds PostgreSQL 18's programs for
# the backup container (pg_dump, pg_restore, a scratch cluster for checks), so the app image never carries them.
#   docker build --target backup -t health-review:backup .

# Tools for installing dependencies. git: agent-core is a public GitHub dependency (no token). python3, make, g++: the
# fallback if better-sqlite3 has no prebuilt binary for this platform.
FROM node:26-bookworm-slim AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
# Production dependencies only: what the server runs with. (prepare does nothing without a .git folder.)
RUN npm ci --omit=dev && rm -rf /root/.npm

# The location database (server/geo.js): DB-IP's free IP to City Lite (CC BY 4.0, https://db-ip.com), this month's file
# or last month's, for US-only access and the usage totals' approximate locations (about 130 MB). If the city download
# fails, the Country Lite file is used (locations then count as unknown); with neither, the app blocks nothing and emails
# the administrator. The weekly rebuild tries again.
FROM debian:bookworm-slim AS geo
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# GEO_STAMP (the build date, from the deploy workflow) makes each build download the file afresh rather than reuse the cache.
ARG GEO_STAMP=none
RUN echo "location database for build $GEO_STAMP" && mkdir -p /geo \
 && for m in "$(date -u +%Y-%m)" "$(date -u -d "$(date -u +%Y-%m-01) -1 month" +%Y-%m)"; do \
      if curl -fsSL --max-time 300 -o /tmp/city.mmdb.gz "https://download.db-ip.com/free/dbip-city-lite-$m.mmdb.gz" \
         && gunzip -c /tmp/city.mmdb.gz > /geo/city.mmdb && [ -s /geo/city.mmdb ]; then echo "city database $m"; break; fi; \
      rm -f /geo/city.mmdb; \
    done; rm -f /tmp/city.mmdb.gz; \
    if [ ! -s /geo/city.mmdb ]; then \
      for m in "$(date -u +%Y-%m)" "$(date -u -d "$(date -u +%Y-%m-01) -1 month" +%Y-%m)"; do \
        if curl -fsSL --max-time 120 -o /tmp/country.mmdb.gz "https://download.db-ip.com/free/dbip-country-lite-$m.mmdb.gz" \
           && gunzip -c /tmp/country.mmdb.gz > /geo/country.mmdb && [ -s /geo/country.mmdb ]; then echo "country database $m"; break; fi; \
        rm -f /geo/country.mmdb; \
      done; rm -f /tmp/country.mmdb.gz; \
    fi; true
# Apple's iCloud Private Relay addresses with the country each stands for (about 12 MB), which Apple publishes for
# geolocation: DB-IP places relay addresses wrong or nowhere, and without the list visitors with Private Relay on are
# refused (server/geo.js). If the download fails, the app emails the administrator; the weekly rebuild tries again.
RUN echo "Private Relay list for build $GEO_STAMP" \
 && if curl -fsSL --max-time 120 -o /geo/relay.csv "https://mask-api.icloud.com/egress-ip-ranges.csv" && [ -s /geo/relay.csv ]; then \
      echo "Private Relay list: $(wc -l < /geo/relay.csv) ranges"; else rm -f /geo/relay.csv; fi; true

# Amazon RDS's certificate authorities (every region), so the app verifies the database's certificate
# (sslmode=verify-full, db/postgres.ts checkTls). Downloaded over HTTPS from AWS at each build; the build fails without it.
FROM debian:bookworm-slim AS certs
RUN apt-get update  && apt-get install -y --no-install-recommends curl ca-certificates  && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /certs  && curl -fsSL --max-time 120 -o /certs/rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem  && grep -q 'BEGIN CERTIFICATE' /certs/rds-global-bundle.pem

# The PostgreSQL project's Debian signing key, checked against its published fingerprint before apt trusts it.
FROM debian:bookworm-slim AS pgkey
RUN apt-get update  && apt-get install -y --no-install-recommends curl ca-certificates gnupg  && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL --max-time 60 -o /pgdg.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc  && gpg --show-keys --with-colons /pgdg.asc | grep -q '^fpr:::::::::B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8:$'

# Runtime: the same Debian and Node as above, so the native module built there loads here unchanged.
FROM node:26-bookworm-slim AS runtime
# tzdata so TZ resolves; the app itself uses OWNER_TZ for every date and does not depend on TZ. The npm, yarn and corepack
# tools that come with the Node image are removed: the server only ever runs node, and they carry their own
# dependencies (and their vulnerabilities, which the image scan in deploy.yml would otherwise flag). Debian's security
# updates are applied here too, so a fix Debian has shipped (such as OpenSSL's, 2026-10-27) is in the image even before
# the Node base image is rebuilt with it.
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
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
# v3 runs .ts files through Node's type stripping with no build step (docs/adr/0005): a base image without it fails here.
RUN node -e "if (process.features.typescript !== 'strip') { console.error('Node ' + process.version + ' cannot strip TypeScript types'); process.exit(1); }"
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=geo /geo /app/geo
COPY --from=certs /certs /app/certs
COPY . .
# Runs as the unprivileged node user (uid 1000); the mounted /app/data folder must be owned by that uid.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 5188
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5188)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]

# The backup container (docker build --target backup): the runtime plus PostgreSQL 18 from the PostgreSQL project's apt
# repository (pg_dump must be at least the server's major version). No default cluster is created; the scratch clusters
# live in /tmp for one check each (tools/backup/pg.js).
FROM runtime AS backup
USER root
COPY --from=pgkey /pgdg.asc /usr/share/keyrings/postgresql.asc
RUN echo 'deb [signed-by=/usr/share/keyrings/postgresql.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main' > /etc/apt/sources.list.d/pgdg.list  && mkdir -p /etc/postgresql-common/createcluster.d  && echo 'create_main_cluster = false' > /etc/postgresql-common/createcluster.d/no-main.conf  && apt-get update  && apt-get install -y --no-install-recommends postgresql-18  && rm -rf /var/lib/apt/lists/*
ENV PG_BIN=/usr/lib/postgresql/18/bin
USER node
HEALTHCHECK NONE
CMD ["node", "scripts/backup-service.js"]

# The default target: the app and demo image (no PostgreSQL programs).
FROM runtime AS app
