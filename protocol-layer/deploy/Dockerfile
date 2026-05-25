FROM node:20-bookworm-slim AS builder

WORKDIR /app
COPY protocol-layer/package.json protocol-layer/tsconfig.json ./
COPY openapi /opt/openapi
# 拷源码
COPY protocol-layer/src ./src

RUN npm install --no-audit --no-fund
RUN npm run build

# ───── runtime ─────
FROM node:20-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl tini && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /opt/openapi /opt/openapi
COPY protocol-layer/deploy/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

ENV NODE_ENV=prod
ENV HTTP_PORT=8080
ENV OPENAPI_SPEC_PATH=/opt/openapi/protocol-v1.yaml

EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD curl -f http://localhost:8080/healthz || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./entrypoint.sh"]
