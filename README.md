# docker-volume-rbd
Docker volume plugin for ceph rbd

This plugin uses the official ceph/ceph image with a simple node script as docker volume plugin api endpoint.

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
```