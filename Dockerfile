# NexLink as one container: console + REST API + Socket.IO + agent relay on
# one port, with agent downloads for Windows, Linux and macOS built in.
#
#   docker build -t nexlink .
#   docker run -p 3000:3000 -e MONGODB_URI=... -e PUBLIC_URL=https://nexlink.example.com nexlink
#
# Runs on any host that keeps a Node process alive and allows WebSockets
# (Render, Railway, Fly.io, a VPS, Kubernetes). Not for serverless functions:
# agents hold a relay socket and the incident detector runs in the background.

# ── 1 · agent binaries ────────────────────────────────────────────────
FROM golang:1.22-alpine AS agent
WORKDIR /src
COPY networking-agent/go.mod networking-agent/go.sum ./
RUN go mod download
COPY networking-agent/ ./
ENV CGO_ENABLED=0
RUN set -e; mkdir /out; \
    for t in windows/amd64/nexlink-agent.exe linux/amd64/nexlink-agent-linux-amd64 linux/arm64/nexlink-agent-linux-arm64 \
             darwin/amd64/nexlink-agent-darwin-amd64 darwin/arm64/nexlink-agent-darwin-arm64; do \
      GOOS=${t%%/*} rest=${t#*/}; GOARCH=${rest%%/*}; name=${rest#*/}; \
      GOOS=$GOOS GOARCH=$GOARCH go build -trimpath -ldflags '-s -w' -o /out/$name ./cmd/nexlink-agent; \
    done

# ── 2 · web app build ─────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build && npm prune --omit=dev

# ── 3 · runtime ───────────────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app ./
COPY --from=agent /out/ ./public/downloads/
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "server.js", "--production"]
