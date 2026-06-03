# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim

WORKDIR /app

# Pull the latest Debian patches into the slim base so the trivy-image
# stage doesn't trip on stale glibc/openssl CVEs.
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

# Use BuildKit's npm cache so re-installs reuse the cache between builds.
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm install

COPY . .

# Run as the pre-baked `node` user (uid 1000) shipped by the official
# image. Vite binds an unprivileged port and only needs read+write on
# /app, which we chown explicitly.
RUN chown -R node:node /app
USER node

EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
