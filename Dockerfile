FROM node:14-slim AS base
RUN apt-get update
RUN apt-get install -qq ceph-common
RUN apt-get clean

FROM base AS builder
COPY . /app
WORKDIR /app
RUN npm ci
RUN npx tsc
RUN npm prune --production

FROM base
LABEL maintainer="Rob Kaandorp <rob@di.nl>"
COPY --from=builder /app /app
WORKDIR /app
RUN mkdir -p /run/docker/plugins /mnt/state /mnt/volumes /etc/ceph
CMD ["/app/dist/server.js"]