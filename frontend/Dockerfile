# syntax=docker/dockerfile:1.7
FROM node:20-bookworm-slim

WORKDIR /app

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
