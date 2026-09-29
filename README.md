# docker-volume-rbd
Docker volume plugin for ceph rbd.

This plugin uses the ubuntu lts image with a simple script as docker volume plugin api endpoint. The node script uses the standard ceph commandline tools to perform the rbd create, map, unmap, remove and mount operations. This release aligns with the Ceph Tentacle release (v20.2), but it may work with other versions as well.

## Releases / CI

Pushes to `develop` and all pull requests are built, tested and packaged by CI, but never published: they do not push to Docker Hub or create GitHub releases. The plugin version is read from the root `VERSION` file in the form `v<ceph major>.<ceph minor>-r<revision>` (initially `v20.2-r1`). Bump the revision on `develop` before each merge to `master`; for a new Ceph release, use its version, such as `v21.2-r1`.

Merging to `master` publishes `robkaandorp/rbd:<base>` (the moving install tag, e.g. `v20.2`) and `robkaandorp/rbd:<full>` (the immutable revision tag, e.g. `v20.2-r1`) to Docker Hub by pushing the plugin once as `<full>` with `docker plugin push` (this is a Docker managed plugin, so it must be built once), after which `<base>` is pointed at the same manifest on Docker Hub without rebuilding it. It also creates a GitHub release and git tag `<full>` on the exact `master` commit that was built. Publishing fails if that version's release or tag already exists; bump the revision in `VERSION` and merge again.

Publishes run one at a time. If several `master` pushes arrive in quick succession, an intermediate publish may be superseded and skipped; re-run its workflow to publish it. Required repository secrets are `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` (a Docker Hub access token with Read & Write permission). The `VERSION_TAG` repository variable is no longer needed.

For normal use, setup the /etc/ceph folder on the host and install with:

```
% docker plugin install robkaandorp/rbd:v20.2 RBD_CONF_POOL="rbd"
```

All available options (as shown in [`config.json`](./config.json) and from line 9 in [`src\server.ts`](./src/server.ts#L9)) are:

- `RBD_CONF_POOL`
  - default: `rbd`
- `RBD_CONF_CLUSTER`
  - unset by default; when unset, the `rbd` CLI uses its own defaults (cluster `ceph`)
- `RBD_CONF_KEYRING_USER`
  - unset by default; when unset, the `rbd` CLI uses its own defaults (user `admin`)
  - Ceph user name without the `client.` prefix. For example, setting `customuser` makes Ceph look for `/etc/ceph/<cluster>.client.customuser.keyring`.
- `RBD_CONF_MAP_OPTIONS`
  - default: `--exclusive`: ensures that only one instance can mount the rbd at a time to prevent corruption)
  - Provide a semicolon separated list to provide multiple options directly to the `rbd map` command. eg `RBD_CONF_MAP_OPTIONS="--exclusive;--read-only;--options noshare,lock_on_read"`

Build with or use the [`build.sh`](./build.sh) build script (_do not do this on a production system!_):

```
% docker build . -t robkaandorp/rbd:v20.2

% id=$(docker create robkaandorp/rbd:v20.2 true)
% mkdir rootfs
% docker export "$id" | sudo tar -x -C rootfs
% docker rm -vf "$id"
% docker rmi robkaandorp/rbd:v20.2

% docker plugin create robkaandorp/rbd:v20.2 .
% rm -rf rootfs

% docker plugin enable robkaandorp/rbd:v20.2
```

If you install with the build script rather than via the Docker Hub OR you need to change the options after install, then you can configure the options with:

```shell
docker plugin set robkaandorp/rbd:v20.2 RBD_CONF_POOL="rbd.custom" RBD_CONF_KEYRING_USER="customuser"
```


Example of how to create a volume:

```
% docker volume create -d robkaandorp/rbd:v20.2 -o size=150M -o fstype=xfs test2
```

size and fstype are optional and default to 200M and xfs respectively.

In my development setup (hyper-v virtualized ceph and docker nodes), the xfs filesystem gives me better write performance over ext4, read performance is about the same.

**WARNING**: do _NOT_ mount a volume on multiple hosts at the same time to prevent filesystem corruption! If you need to share a filesysem between hosts use CephFS or Cifs.