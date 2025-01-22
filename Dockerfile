FROM ubuntu AS base
ENV LANG=en_GB.UTF-8
RUN apt-get update
RUN apt-get install -y locales curl && \
    echo "$LANG UTF-8" > /etc/locale.gen && \
    dpkg-reconfigure --frontend=noninteractive locales && \
    update-locale LANG=$LANG
RUN curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
RUN apt-get install -qq nodejs ceph-common xfsprogs kmod
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
RUN chmod +x entrypoint.sh
CMD ["/app/entrypoint.sh"]