# Build context: repository root
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/
RUN npm ci -w @puantaj/web --include-workspace-root
COPY apps/web apps/web
RUN npm run build -w @puantaj/web

FROM nginx:1.27-alpine
COPY deploy/nginx.web.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
