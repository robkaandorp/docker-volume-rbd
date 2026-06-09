FROM ubuntu AS base
ENV LANG=en_GB.UTF-8
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        locales curl ca-certificates && \
    echo "$LANG UTF-8" > /etc/locale.gen && \
    dpkg-reconfigure --frontend=noninteractive locales && \
    update-locale LANG=$LANG && \
    curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && \
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