FROM ubuntu:22.04 AS base
ENV LANG=en_GB.UTF-8
# Pin ceph-common to the Ceph Squid (19.2.x) client from the official Ceph repo.
# Newer clients (20.x+) emit the krbd 'ms_mode' map option, which is unsupported
# by kernels < 5.11 and breaks 'rbd map' on the swarm hosts (kernel 5.10).
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        locales curl ca-certificates gnupg && \
    echo "$LANG UTF-8" > /etc/locale.gen && \
    dpkg-reconfigure --frontend=noninteractive locales && \
    update-locale LANG=$LANG && \
    curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && \
    curl -fsSL https://download.ceph.com/keys/release.asc | gpg --dearmor -o /usr/share/keyrings/ceph.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/ceph.gpg] https://download.ceph.com/debian-squid/ jammy main" > /etc/apt/sources.list.d/ceph.list && \
    apt-get update && \
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