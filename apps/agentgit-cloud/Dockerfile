FROM node:24-bookworm-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV NEXT_TELEMETRY_DISABLED=1
ENV TURBO_TELEMETRY_DISABLED=1

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

FROM base AS builder

WORKDIR /app

COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm turbo build

FROM base AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

COPY --from=builder /app /app

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/v1/healthz').then((response)=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "--filter", "@agentgit/cloud-ui", "exec", "next", "start", "-H", "0.0.0.0", "-p", "3000"]
