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

# Runtime: the same Debian and Node as above, so the native module built there loads here unchanged.
FROM node:22-bookworm-slim
# tzdata so TZ resolves; the app itself uses OWNER_TZ for every date and does not depend on TZ.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    HOST=0.0.0.0 \
    PORT=5188 \
    TZ=America/New_York \
    OWNER_TZ=America/New_York
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Runs as the unprivileged node user (uid 1000); the mounted /app/data folder must be owned by that uid.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 5188
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5188)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
