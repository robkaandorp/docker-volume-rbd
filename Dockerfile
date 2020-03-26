FROM ceph/ceph:v15.2 AS ceph_with_npm
RUN curl -sL https://rpm.nodesource.com/setup_12.x | bash -
RUN yum install -y nodejs

FROM ceph_with_npm
LABEL maintainer="Rob Kaandorp <rob@di.nl>"
COPY . /app
WORKDIR /app
RUN npm install
RUN npx tsc
RUN npm prune --production
RUN mkdir -p /run/docker/plugins /mnt/state /mnt/volumes /etc/ceph
CMD ["node", "dist/server.js"]