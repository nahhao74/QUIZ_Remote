FROM node:22-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@10.17.1 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
ARG VITE_MQTT_WS_URL
ARG VITE_MQTT_USERNAME
ARG VITE_MQTT_PASSWORD
ENV VITE_MQTT_WS_URL=$VITE_MQTT_WS_URL VITE_MQTT_USERNAME=$VITE_MQTT_USERNAME VITE_MQTT_PASSWORD=$VITE_MQTT_PASSWORD
RUN pnpm --filter @classpulse/shared-types build && pnpm --filter @classpulse/mqtt-contracts build && pnpm --filter @classpulse/frontend build
FROM nginx:1.28-alpine
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1
COPY infra/nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/frontend/dist /usr/share/nginx/html
EXPOSE 80
