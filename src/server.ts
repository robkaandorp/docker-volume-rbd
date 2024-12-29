import express from "express";
import bodyParser from "body-parser";
import process from "process";

import Rbd from "./rbd";
import MountPointEntry from "./mountPointEntry";

const socketAddress = "/run/docker/plugins/rbd.sock";
const pool = process.env.RBD_CONF_POOL || "rbd";
const cluster = process.env.RBD_CONF_CLUSTER || "ceph"; // ToDo: Not utilised currently
const user = process.env.RBD_CONF_KEYRING_USER || "admin"; // ToDo: Not utilised currently
const mapoptions = process.env.RBD_CONF_MAPOPTIONS.split(',') || ["--exclusive"]; // default to an exclusive lock when mapping to prevent multiple containers attempting to mount the block device
const rbd = new Rbd({ pool: pool, cluster: cluster, user: user, mapoptions: mapoptions });

const app = express();
app.use(bodyParser.json({ strict: false, type: req => true }));

// Documentation about docker volume plugins can be found here: https://docs.docker.com/engine/extend/plugins_volume/

app.post("/Plugin.Activate", (request, response) => {
    console.log("Activating rbd volume driver");

    response.json({
        "Implements": ["VolumeDriver"]
    });
});

let mountPointTable = new Map<string, MountPointEntry>();

function getMountPoint(name: string): string {
    return `/mnt/volumes/${pool}/${name}`;
}

/*
    Instruct the plugin that the user wants to create a volume, given a user specified volume name. 
    The plugin does not need to actually manifest the volume on the filesystem yet (until Mount is 
    called). Opts is a map of driver specific options passed through from the user request.
*/
app.post("/VolumeDriver.Create", async (request, response) => {
    const req = request.body as { Name: string, Opts: { size: string, fstype: string } };
    const fstype = req.Opts?.fstype || "xfs";
    const size = req.Opts?.size || "200M";

    console.log(`Creating rbd volume ${req.Name}`);

    try {
        await rbd.create(req.Name, size);
        let device = await rbd.map(req.Name);
        await rbd.makeFilesystem(fstype, device);
        await rbd.unMap(req.Name);
    }
    catch (error) {
        return response.json({ Err: error.message });
    }

    response.json({
        Err: ""
    });
});

/*
    Delete the specified volume from disk. This request is issued when a user invokes 
    docker rm -v to remove volumes associated with a container.
*/
app.post("/VolumeDriver.Remove", async (request, response) => {
    const req = request.body as { Name: string };

    console.log(`Removing rbd volume ${req.Name}`);

    try {
        await rbd.unMap(req.Name);
        await rbd.remove(req.Name);
    }
    catch (error) {
        return response.json({ Err: error.message });
    }

    response.json({
        Err: ""
    });
});

/*
    Docker requires the plugin to provide a volume, given a user specified volume name. 
    Mount is called once per container start. If the same volume_name is requested more 
    than once, the plugin may need to keep track of each new mount request and provision 
    at the first mount request and deprovision at the last corresponding unmount request.
*/
app.post("/VolumeDriver.Mount", async (request, response) => {
    const req = request.body as { Name: string, ID: string };
    const mountPoint = getMountPoint(req.Name);

    console.log(`Mounting rbd volume ${req.Name}`);

    if (mountPointTable.has(mountPoint)) {
        console.log(`${mountPoint} already mounted, nothing to do`);
        mountPointTable.get(mountPoint).references.push(req.ID);

        return response.json({
            MountPoint: mountPoint,
            Err: ""
        });
    }

    try {
        let device = await rbd.isMapped(req.Name);

        if (!device) {
            device = await rbd.map(req.Name);
        }

        await rbd.mount(device, mountPoint);
    }
    catch (error) {
        return response.json({ Err: error.message });
    }

    mountPointTable.set(mountPoint, 
        new MountPointEntry( 
            req.Name, 
            mountPoint,
            req.ID));
    
    response.json({
        MountPoint: mountPoint,
        Err: ""
    });
});

/*
    Request the path to the volume with the given volume_name.
*/
app.post("/VolumeDriver.Path", (request, response) => {
    const req = request.body as { Name: string };
    const mountPoint = getMountPoint(req.Name);

    console.log(`Request path of rbd mount ${req.Name}`);

    if (mountPointTable.has(mountPoint)) {
        response.json({
            MountPoint: mountPoint,
            Err: ""
        });
    } else {
        response.json({ Err: "" });
    }
});

/*
    Docker is no longer using the named volume. Unmount is called once per container stop. 
    Plugin may deduce that it is safe to deprovision the volume at this point.

    ID is a unique ID for the caller that is requesting the mount.
*/
app.post("/VolumeDriver.Unmount", async (request, response) => {
    const req = request.body as { Name: string, ID: string };
    const mountPoint = getMountPoint(req.Name);

    console.log(`Unmounting rbd volume ${req.Name}`);

    if (!mountPointTable.has(mountPoint)) {
        const error = `Unknown volume ${req.Name}`;
        console.error(error);
        return response.json({ Err: error });
    }

    let mountPointEntry = mountPointTable.get(mountPoint);

    if (!mountPointEntry.hasReference(req.ID)) {
        const error = `Unknown caller id ${req.ID} for volume ${req.Name}`;
        console.error(error);
        return response.json({ Err: error });
    }

    const remainingIds = mountPointEntry.references.filter(id => id !== req.ID);

    if (remainingIds.length > 0) {
        console.log(`${remainingIds.length} references to volume ${req.Name} remaining, not unmounting..`);
        mountPointEntry.references = remainingIds;
        return response.json({ Err: "" });
    } 

    try {
        await rbd.unmount(mountPoint);
        mountPointTable.delete(mountPoint);
        await rbd.unMap(req.Name);
    }
    catch (error) {
        return response.json({ Err: error.message });
    }

    response.json({
        Err: ""
    });
});

/*
    Get info about volume_name.
*/
app.post("/VolumeDriver.Get", async (request, response) => {
    const req = request.body as { Name: string };
    const mountPoint = getMountPoint(req.Name);
    const entry = mountPointTable.has(mountPoint) 
        ? mountPointTable.get(mountPoint)
        : null;

    console.log(`Getting info about rbd volume ${req.Name}`);

    try {
        const info = await rbd.getInfo(req.Name);

        if (!info) {
            return response.json({ Err: "" });
        }

        response.json({
            Volume: {
                Name: req.Name,
                Mountpoint: entry?.mountPoint || "",
                Status: {
                    size: info.size
                }
            },
            Err: ""
        });
    } catch (error) {
        return response.json({ Err: error.message });
    }
});

/*
    Get the list of volumes registered with the plugin.
*/
app.post("/VolumeDriver.List", async (request, response) => {
    console.log("Getting list of registered rbd volumes");

    try {
        const rbdList = await rbd.list();

        response.json({
            Volumes: rbdList.map(info => {
                const mountPoint = getMountPoint(info.image);
                const entry = mountPointTable.has(mountPoint) 
                    ? mountPointTable.get(mountPoint)
                    : null;
    
                return {
                    Name: name,
                    Mountpoint: entry?.mountPoint || ""
                };
            }),
            Err: ""
          });
    }
    catch (error) {
        return response.json({ Err: error.message });
    }
});

app.post("/VolumeDriver.Capabilities", (request, response) => {
    console.log("Getting the list of capabilities");

    response.json({
        Capabilities: {
          Scope: "global"
        }
      });
});


app.listen(socketAddress, () => {
    console.log(`Plugin rbd listening on socket ${socketAddress}`);
});