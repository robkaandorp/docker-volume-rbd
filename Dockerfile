FROM ceph/ceph:v15.2 AS base
RUN curl -sL https://rpm.nodesource.com/setup_12.x | bash -
RUN yum install -y nodejs
RUN yum clean packages && yum clean metadata && yum clean all && rm -rf /var/cache/dnf

FROM base AS builder
COPY . /app
WORKDIR /app
RUN npm install
RUN npx tsc
RUN npm prune --production

FROM base
LABEL maintainer="Rob Kaandorp <rob@di.nl>"
COPY --from=builder /app /app
WORKDIR /app
RUN mkdir -p /run/docker/plugins /mnt/state /mnt/volumes /etc/ceph
RUN chmod +x entrypoint.sh
CMD ["/app/entrypoint.sh"]