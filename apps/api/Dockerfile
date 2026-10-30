# syntax=docker/dockerfile:1.7
# Image de l'API, du worker et des migrations (même image, commandes différentes).
# À construire depuis la racine du dépôt : docker build -f apps/api/Dockerfile .

ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS base
# OpenSSL est requis par les moteurs Prisma. Mettre INSTALL_SYSTEM_DEPS=false avec une image
# qui le contient déjà (ex. NODE_IMAGE=node:22-bookworm) sur un réseau sans accès aux dépôts Debian.
ARG INSTALL_SYSTEM_DEPS=true
RUN if [ "$INSTALL_SYSTEM_DEPS" = "true" ]; then \
      apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*; \
    fi
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
WORKDIR /repo

FROM base AS build
# Certificat facultatif (proxy d'entreprise) : --secret id=ca,src=chemin/vers/ca.crt
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    corepack enable && corepack prepare pnpm@10.28.0 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    pnpm install --frozen-lockfile --filter @ecole/api...
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @ecole/shared build && pnpm --filter @ecole/api build
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    pnpm --filter @ecole/api deploy --prod --legacy /out \
    && cp -r apps/api/dist apps/api/prisma /out/ \
    && cd /out && ./node_modules/.bin/prisma generate

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/main.js"]
