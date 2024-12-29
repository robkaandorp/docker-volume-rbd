# docker-volume-rbd
Docker volume plugin for ceph rbd.

This plugin uses the ubuntu lts image with a simple script as docker volume plugin api endpoint. The node script uses the standard ceph commandline tools to perform the rbd create, map, unmap, remove and mount operations. This release aligns with the Ceph Quincy release (v17.2), but it may work with other versions as well.

For normal use, setup the /etc/ceph folder on the host and install with:

```
% docker plugin install robkaandorp/rbd:v17.2 RBD_CONF_POOL="rbd"
```

All available options (as shown in [`config.json`](./config.json) and from line 9 in [`src\server.ts`](./src/server.ts#L9)) are:

- `RBD_CONF_POOL` (default: `rbd`)
- `RBD_CONF_CLUSTER` (default: `ceph`)
- `RBD_CONF_KEYRING_USER` (default: `admin`)

Build with or use the [`build.sh`](./build.sh) build script (_do not do this on a production system!_):

```
% docker build . -t robkaandorp/rbd:v17.2

% id=$(docker create robkaandorp/rbd:v17.2 true)
% mkdir rootfs
% docker export "$id" | sudo tar -x -C rootfs
% docker rm -vf "$id"
% docker rmi robkaandorp/rbd:v17.2

% docker plugin create robkaandorp/rbd:v17.2 .
% rm -rf rootfs

% docker plugin enable robkaandorp/rbd:v17.2
```

If you install with the build script rather than via the Docker Hub OR you need to change the options after install, then you can configure the options with:

```shell
docker plugin set robkaandorp/rbd:v17.2 RBD_CONF_POOL="rbd.custom" RBD_CONF_KEYRING_USER="customuser"
```


Example of how to create a volume:

```
% docker volume create -d robkaandorp/rbd:v17.2 -o size=150M -o fstype=xfs test2
```

size and fstype are optional and default to 200M and xfs respectively.

In my development setup (hyper-v virtualized ceph and docker nodes), the xfs filesystem gives me better write performance over ext4, read performance is about the same.

**WARNING**: do _NOT_ mount a volume on multiple hosts at the same time to prevent filesystem corruption! If you need to share a filesysem between hosts use CephFS or Cifs.