#!/bin/bash

docker plugin disable robkaandorp/rbd:v16.2 -f
docker plugin rm robkaandorp/rbd:v16.2 -f
rm -rf plugin

git pull
docker build . -t robkaandorp/rbd:v16.2

id=$(docker create robkaandorp/rbd:v16.2 true)
mkdir -p plugin/rootfs
cp config.json plugin/
docker export "$id" | sudo tar -x -C plugin/rootfs
docker rm -vf "$id"
docker rmi robkaandorp/rbd:v16.2

docker plugin create robkaandorp/rbd:v16.2 plugin/
docker plugin enable robkaandorp/rbd:v16.2
docker plugin ls
