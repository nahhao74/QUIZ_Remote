FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.17.1 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @classpulse/shared-types build && pnpm --filter @classpulse/mqtt-contracts build && pnpm --filter @classpulse/backend build
USER node
EXPOSE 3000
CMD ["sh", "-c", "pnpm db:migrate && pnpm --filter @classpulse/backend start"]
