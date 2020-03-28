# docker-volume-rbd
Docker volume plugin for ceph rbd.

This plugin uses the official ceph/ceph image with a simple node script as docker volume plugin api endpoint. The node script uses the standard ceph commandline tools to perform the rbd create, map, unmap, remove and mount operations. This release aligns with the Ceph Octopus release (v15.2).

For normal use, install with:

```
% docker plugin install robkaandorp/rbd:v15.2 RBD_CONF_POOL="rbd"
```

where RBD_CONF_POOL is optional and defaults to "rbd".

Build with:

```
% docker build . -t robkaandorp/rbd:v15.2

% id=$(docker create robkaandorp/rbd:v15.2 true)
% mkdir rootfs
% docker export "$id" | sudo tar -x -C rootfs
% docker rm -vf "$id"
% docker rmi robkaandorp/rbd:v15.2

% docker plugin create robkaandorp/rbd:v15.2 .
% rm -rf rootfs

% docker plugin enable robkaandorp/rbd:v15.2
```

Example of how to create a volume:

```
% docker volume create -d robkaandorp/rbd:v15.2 -o size=150M -o fstype=xfs test2
```