FROM ubuntu:24.04 AS base
ENV LANG=en_GB.UTF-8
# ceph-common is installed from the official download.ceph.com 'debian-tentacle'
# repository (Ceph Tentacle 20.2), matching the swarm hosts, which have been
# upgraded to Tentacle 20.2.
COPY .node-version /tmp/.node-version
RUN apt-get update && \
    apt-get install -y --no-install-recommends locales curl ca-certificates gpg && \
    echo "$LANG UTF-8" > /etc/locale.gen && \
    dpkg-reconfigure --frontend=noninteractive locales && \
    update-locale LANG=$LANG && \
    curl -fsSL https://download.ceph.com/keys/release.asc | gpg --dearmor -o /usr/share/keyrings/ceph.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/ceph.gpg] https://download.ceph.com/debian-tentacle/ noble main" | tee /etc/apt/sources.list.d/ceph.list && \
    curl -fsSL https://deb.nodesource.com/setup_$(tr -d '[:space:]' < /tmp/.node-version).x | bash - && \
    apt-get install -y --no-install-recommends nodejs ceph-common xfsprogs kmod && \
    rm -rf /var/lib/apt/lists/*

FROM base AS builder
WORKDIR /app
RUN corepack enable pnpm
COPY package.json pnpm-lock.yaml ./
RUN pnpm ci
COPY . .
RUN pnpm run build
RUN pnpm prune --prod

FROM base
LABEL maintainer="Rob Kaandorp <rob@di.nl>"
COPY --from=builder /app /app
WORKDIR /app
RUN mkdir -p /run/docker/plugins /mnt/state /mnt/volumes /etc/ceph
RUN chmod +x entrypoint.sh
CMD ["/app/entrypoint.sh"]