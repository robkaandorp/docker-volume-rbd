#!/bin/bash

docker volume disable robkaandorp/rbd:v15.2 -f
docker volume rm robkaandorp/rbd:v15.2 -f
rm -rf rootfs

git pull
docker build . -t robkaandorp/rbd:v15.2

id=$(docker create robkaandorp/rbd:v15.2 true)
mkdir rootfs
docker export "$id" | sudo tar -x -C rootfs
docker rm -vf "$id"
docker rmi robkaandorp/rbd:v15.2

docker plugin create robkaandorp/rbd:v15.2 .
docker plugin enable robkaandorp/rbd:v15.2