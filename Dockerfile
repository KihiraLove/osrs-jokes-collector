# syntax=docker/dockerfile:1
FROM node:24.22.3-bookworm-slim AS tooling
WORKDIR /app
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml ./

FROM tooling AS production-dependencies
RUN --mount=type=cache,target=/pnpm/store pnpm install --frozen-lockfile --prod --ignore-scripts --store-dir=/pnpm/store

FROM tooling AS build
RUN --mount=type=cache,target=/pnpm/store pnpm install --frozen-lockfile --ignore-scripts --store-dir=/pnpm/store
COPY tsconfig.json tsconfig.build.json ./
COPY scripts/copy-assets.mjs ./scripts/copy-assets.mjs
COPY src ./src
RUN pnpm build

FROM node:24.22.3-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 CMD ["node", "dist/healthcheck.js"]
ENTRYPOINT ["node"]
CMD ["dist/server.js"]
