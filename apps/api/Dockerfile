# Build context: repository root
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/payroll/package.json packages/payroll/
COPY apps/api/package.json apps/api/
RUN npm ci -w @puantaj/payroll -w @puantaj/api --include-workspace-root
COPY packages/payroll packages/payroll
COPY apps/api apps/api
RUN npm run build -w @puantaj/payroll \
 && npx -w @puantaj/api prisma generate \
 && npm run build -w @puantaj/api

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4000
# node_modules keeps the Prisma CLI so migrations can run on start
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/payroll/package.json packages/payroll/
COPY --from=build /app/packages/payroll/dist packages/payroll/dist
COPY --from=build /app/apps/api/package.json apps/api/
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/prisma apps/api/prisma
WORKDIR /app/apps/api
USER node
EXPOSE 4000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
