# Build context: repository root
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY scripts/mark-module-type.mjs scripts/
COPY packages/schemas/package.json packages/schemas/
COPY apps/web/package.json apps/web/
RUN npm ci -w @puantaj/schemas -w @puantaj/web --include-workspace-root
COPY packages/schemas packages/schemas
COPY apps/web apps/web
RUN npm run build -w @puantaj/schemas && npm run build -w @puantaj/web

FROM nginx:1.27-alpine
COPY deploy/nginx.web.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
