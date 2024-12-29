#!/bin/bash

version=19.2
pluginname=robkaandorp/rbd
pluginnametagged=$pluginname:$version
echo $pluginnametagged

docker plugin disable $pluginnametagged -f
docker plugin rm $pluginnametagged -f
rm -rf plugin

git pull
docker build . -t $pluginnametagged

id=$(docker create $pluginnametagged true)
mkdir -p plugin/rootfs
cp config.json plugin/
docker export "$id" | sudo tar -x -C plugin/rootfs
docker rm -vf "$id"
docker rmi $pluginnametagged

docker plugin create $pluginnametagged plugin/
docker plugin enable $pluginnametagged
docker plugin ls
