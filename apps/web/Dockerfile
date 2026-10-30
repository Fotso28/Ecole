# syntax=docker/dockerfile:1.7
# Image du site Next.js en mode autonome.
# À construire depuis la racine du dépôt : docker build -f apps/web/Dockerfile .

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo

FROM base AS build
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    corepack enable && corepack prepare pnpm@10.28.0 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    pnpm install --frozen-lockfile --filter @ecole/web...
COPY packages/shared packages/shared
COPY apps/web apps/web
# API_URL : adresse interne de l'API, utilisée côté serveur (page de vérification publique).
ARG API_URL=http://api:4000
ENV API_URL=$API_URL NEXT_OUTPUT=standalone NEXT_PUBLIC_MOBILE_MONEY_SIMULATOR=false
RUN pnpm --filter @ecole/shared build && pnpm --filter @ecole/web build

FROM base AS runtime
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/connexion').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
