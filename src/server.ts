import express from "express";
import bodyParser from "body-parser";
import util from 'util';
import child_process from "child_process";
const execFile = util.promisify(child_process.execFile);
import process from "process";
import fs from "fs";

const socketAddress = "/run/docker/plugins/rbd.sock";
const pool = process.env.RBD_CONF_POOL || "rbd";
const cluster = process.env.RBD_CONF_CLUSTER || "ceph";
const user = process.env.RBD_CONF_KEYRING_USER || "admin";

const app = express();
app.use(bodyParser.json({ strict: false, type: req => true }));

// Documentation about docker volume plugins can be found here: https://docs.docker.com/engine/extend/plugins_volume/

app.post("/Plugin.Activate", (request, response) => {
    console.log("Activating rbd volume driver");

    response.json({
        "Implements": ["VolumeDriver"]
    });
});

class MountPointEntry {
    constructor(
        readonly name: string,
        readonly imageName: string,
        readonly mountPoint: string,
        referenceId: string) {
        this.references = [referenceId];
    }

    references: string[];

    hasReference(id: string): boolean {
        return !!this.references.find(refid => refid === id);
    }
}

let mountPointTable = new Map<string, MountPointEntry>();

function getImageName(volumeName: string): string {
    return `${pool}/${volumeName}`;
}

/*
    Instruct the plugin that the user wants to create a volume, given a user specified volume name. 
    The plugin does not need to actually manifest the volume on the filesystem yet (until Mount is 
    called). Opts is a map of driver specific options passed through from the user request.
*/
app.post("/VolumeDriver.Create", async (request, response) => {
    const req = request.body as { Name: string, Opts: { size: string, fstype: string } };
    const imageName = getImageName(req.Name);
    const fstype = req.Opts?.fstype || "xfs";
    const size = req.Opts?.size || "200M";

    console.log(`Creating rbd volume ${imageName}`);

    try {
        const { stdout, stderr } = await execFile("rbd", ["create", imageName, "--size", size], { timeout: 30000 });
        if (stderr) console.log(stderr);
        if (stdout) console.log(stdout);
    }
    catch (error) {
        console.error(error);
        return response.json({ Err: `rbd create command failed with code ${error.code}: ${error.message}` });
    }

    let device = "";
    try {
        const { stdout, stderr } = await execFile("rbd", ["map", imageName], { timeout: 30000 });
        if (stderr) console.log(stderr);
        device = (stdout as string).trim();
    }
    catch (error) {
        console.error(error);
        return response.json({ Err: `rbd map command failed with code ${error.code}: ${error.message}` });
    }

    try {
        const { stdout, stderr } = await execFile(`mkfs.${fstype}`, [device], { timeout: 120000 });
        if (stderr) console.error(stderr);
        if (stdout) console.log(stdout);
    }
    catch (error) {
        console.error(error);
        return response.json({ Err: `mkfs.${fstype} ${device} command failed with code ${error.code}: ${error.message}` });
    }

    try {
        const { stdout, stderr } = await execFile("rbd", ["unmap", imageName], { timeout: 30000 });
        if (stderr) console.log(stderr);
        if (stdout) console.log(stdout);
    }
    catch (error) {
        console.error(error);
        return response.json({ Err: `rbd unmap command failed with code ${error.code}: ${error.message}` });
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
    const imageName = getImageName(req.Name);

    console.log(`Removing rbd volume ${imageName}`);

    try {
        const { stdout, stderr } = await execFile("rbd", ["unmap", imageName], { timeout: 30000 });
        if (stderr) console.log(stderr);
        if (stdout) console.log(stdout);
    }
    catch (error) {
        console.error(error);
        return response.json({ Err: `rbd unmap command failed with code ${error.code}: ${error.message}` });
    }

    try {
        const { stdout, stderr } = await execFile("rbd", ["remove", "--no-progress", imageName], { timeout: 30000 });
        if (stderr) console.log(stderr);
        if (stdout) console.log(stdout);
    }
    catch (error) {
        console.error(error);
        return response.json({ Err: `rbd remove command failed with code ${error.code}: ${error.message}` });
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
    const imageName = getImageName(req.Name);
    const mountPoint = `/mnt/volumes/${imageName}`;

    console.log(`Mounting rbd volume ${imageName}`);

    let device = "";
    try {
        const { stdout, stderr } = await execFile("rbd", ["map", imageName], { timeout: 30000 });
        if (stderr) console.log(stderr);
        device = (stdout as string).trim();
    }
    catch (error) {
        console.error(error);
        return response.json({ Err: `rbd map command failed with code ${error.code}: ${error.message}` });
    }

    try {
        fs.mkdirSync(mountPoint, { recursive: true });
    }
    catch (error) {
        console.error(error);
        return response.json({ Err: `mkdir command failed with code ${error.code}: ${error.message}` });
    }

    try {
        const { stdout, stderr } = await execFile("mount", [device, mountPoint], { timeout: 30000 });
        if (stderr) console.error(stderr);
        if (stdout) console.log(stdout);
    }
    catch (error) {
        console.error(error);
        return response.json({ Err: `mount command failed with code ${error.code}: ${error.message}` });
    }

    if (mountPointTable.has(mountPoint)) {
        mountPointTable.get(mountPoint).references.push(req.ID);
    } else {
        mountPointTable.set(mountPoint, 
            new MountPointEntry( 
                req.Name, 
                imageName, 
                mountPoint,
                req.ID));
    }
    
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
    const imageName = getImageName(req.Name);
    const mountPoint = `/mnt/volumes/${imageName}`;

    console.log(`Request path of rbd mount ${imageName}`);

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
    const imageName = getImageName(req.Name);
    const mountPoint = `/mnt/volumes/${imageName}`;

    console.log(`Unmounting rbd volume ${imageName}`);

    if (!mountPointTable.has(mountPoint)) {
        const error = `Unknown volume ${imageName}`;
        console.error(error);
        return response.json({ Err: error });
    }

    let mountPointEntry = mountPointTable.get(mountPoint);

    if (!mountPointEntry.hasReference(req.ID)) {
        const error = `Unknown caller id ${req.ID} for volume ${imageName}`;
        console.error(error);
        return response.json({ Err: error });
    }

    const remainingIds = mountPointEntry.references.filter(id => id !== req.ID);

    if (remainingIds.length > 0) {
        console.log(`${remainingIds.length} references to volume ${imageName} remaining, not unmounting..`);
        mountPointEntry.references = remainingIds;
        return response.json({ Err: "" });
    } 

    try {
        const { stdout, stderr } = await execFile("umount", [mountPoint], { timeout: 30000 });
        if (stderr) console.error(stderr);
        if (stdout) console.log(stdout);
    }
    catch (error) {
        console.error(error);
        return response.json({ Err: `umount command failed with code ${error.code}: ${error.message}` });
    }

    mountPointTable.delete(mountPoint);

    try {
        fs.rmdirSync(mountPoint);
    }
    catch (error) {
        console.error(error);
        return response.json({ Err: `rmdir command failed with code ${error.code}: ${error.message}` });
    }

    try {
        const { stdout, stderr } = await execFile("rbd", ["unmap", imageName], { timeout: 30000 });
        if (stderr) console.log(stderr);
        if (stdout) console.log(stdout);
    }
    catch (error) {
        console.error(error);
        return response.json({ Err: `rbd unmap command failed with code ${error.code}: ${error.message}` });
    }

    response.json({
        Err: ""
    });
});

/*
    Get info about volume_name.
*/
app.post("/VolumeDriver.Get", (request, response) => {
    const req = request.body as { Name: string };
    const imageName = getImageName(req.Name);
    const mountPoint = `/mnt/volumes/${imageName}`;

    console.log(`Getting info about rbd volume ${imageName}`);

    if (mountPointTable.has(mountPoint)) {
        response.json({
            Volume: {
            Name: req.Name,
            Mountpoint: mountPoint,
            Status: {}
            },
            Err: ""
        });
    } else {
        response.json({ Err: "" });
    }
});

/*
    Get the list of volumes registered with the plugin.
*/
app.post("/VolumeDriver.List", (request, response) => {
    console.log("Getting list of registered rbd volumes");

    response.json({
        Volumes: [ ...mountPointTable.keys() ].map((mountPoint: string) => {
            return {
                Name: mountPointTable.get(mountPoint).name,
                Mountpoint: mountPoint
            };
        }),
        Err: ""
      });
});

app.post("/VolumeDriver.Capabilities", (request, response) => {
    console.log("Getting the list of capabilities");

    response.json({
        Capabilities: {
          Scope: "global"
        }
      });
});


app.listen(socketAddress, err => {
    if (err) {
        return console.error(err);
    }

    console.log(`Plugin rbd listening on socket ${socketAddress}`);
});