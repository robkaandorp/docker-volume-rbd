#!/bin/bash

version=v19.2
pluginname=robkaandorp/rbd
pluginnametagged=$pluginname:$version
echo $pluginnametagged

docker plugin disable $pluginnametagged -f
docker plugin rm $pluginnametagged -f
sudo rm -rf plugin

git pull
docker build . -t $pluginnametagged

id=$(docker create $pluginnametagged true)
mkdir -p plugin/rootfs
cp config.json plugin/
docker export "$id" -o plugin/container.tar
sudo tar --extract -f plugin/container.tar --directory plugin/rootfs
rm plugin/container.tar
docker rm -vf "$id"
docker rmi $pluginnametagged

sudo docker plugin create $pluginnametagged plugin/
# docker plugin enable $pluginnametagged
docker plugin ls
