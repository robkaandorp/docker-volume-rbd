import express from "express";

import type Rbd from "./rbd";
import MountPointEntry from "./mountPointEntry";

/*
    The Rbd methods the app uses. Declaring it as a Pick keeps the app decoupled from
    the concrete implementation, so tests can pass a plain stub object.
*/
export type RbdInterface = Pick<Rbd, "create" | "map" | "makeFilesystem" | "unMap" | "isMapped" | "mount" | "unmount" | "remove" | "getInfo" | "list">;

/*
    Scope of the Mount/Create rollback:

    - Rollback is best-effort. When a cleanup command itself fails, the mapping or directory
      may still be left behind; that is logged and never replaces the original error.
    - Ownership is tracked per request, from what this request actually did. A mapping this
      request created (a successful rbd.map after isMapped reported nothing) is rolled back;
      a mapping or image that was already there belongs to someone else and is left alone.
    - Exclusive locking (--exclusive) is the code default, but is currently disabled in
      production by configuration. Rollback must work whether or not it is on, so nothing
      here may depend on an exclusive lock being held.

    Scope of the per-volume serialisation:

    - Operations on the same volume run one at a time, operations on different volumes run
      concurrently.
    - The lock serialises requests within this plugin process only. It does not coordinate with
      other plugin processes, other nodes or other Docker hosts, and it says nothing about what
      is mapped or mounted elsewhere. Cross-node protection is what `rbd map --exclusive` is for.
*/

/** Runs a rollback command, logging (but swallowing) its failure so the original error survives. */
async function cleanupBestEffort(action: () => Promise<void>, description: string): Promise<void> {
    try {
        await action();
    }
    catch (cleanupError) {
        console.error(`Cleanup failed: could not ${description}`, cleanupError);
    }
}

/*
    Serialises operations that target the same volume name, so two requests for one volume run one
    at a time while operations on different volumes still run concurrently.

    Plain Promise/Map only: one promise chain per volume name. Entries are dropped as soon as their
    chain finished, so the map cannot grow without bound, and a finished chain absorbs its rejection,
    so a failed operation does not break the queue for the operations waiting behind it. The caller
    of withVolumeLock still sees the original rejection, which the handlers turn into an Err response.

    Kept as a factory so every createApp call (and therefore every test) gets its own isolated lock,
    and so the lock itself can be exercised without an HTTP round trip.
*/
export function createVolumeLock() {
    const chains = new Map<string, Promise<unknown>>();

    function dropIfLast(name: string, tail: Promise<unknown>): void {
        // Only the last operation queued for this volume may remove the entry; a later operation
        // has already replaced it, and its own cleanup will follow.
        if (chains.get(name) === tail) {
            chains.delete(name);
        }
    }

    return {
        /** Runs `operation` once every operation queued before it for `name` has settled. */
        withVolumeLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
            // Whatever the map holds (or nothing at all) has its rejection absorbed, so the
            // operation runs whether the predecessor resolved or failed.
            const previousChain = chains.get(name) ?? Promise.resolve();
            const result = previousChain.then(operation);

            const tail = result.then(() => undefined, () => undefined);
            chains.set(name, tail);

            /*
                Drop the entry once this operation was the last one for the volume. This handler is
                registered before the caller awaits `result`, so the entry is already gone by the time
                the operation's promise settles - the map cannot accumulate one entry per volume seen.
            */
            void result.then(() => dropIfLast(name, tail), () => dropIfLast(name, tail));

            return result;
        },

        /** Number of volumes with an unfinished chain; 0 when nothing is running or queued. */
        pendingVolumes(): number {
            return chains.size;
        },
    };
}

export function createApp(rbd: RbdInterface, pool: string): express.Express {
    const app = express();
    app.use(express.json({ strict: false, type: req => true }));

    // Documentation about docker volume plugins can be found here: https://docs.docker.com/engine/extend/plugins_volume/

    app.post("/Plugin.Activate", (request, response) => {
        console.log("Activating rbd volume driver");

        response.json({
            "Implements": ["VolumeDriver"]
        });
    });

    let mountPointTable = new Map<string, MountPointEntry>();

    // Created here, not module wide, so apps (and tests) never share a lock.
    const volumeLock = createVolumeLock();

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

        await volumeLock.withVolumeLock(req.Name, async () => {
            let createdImage = false;
            let mappedImage = false;
            let madeFilesystem = false;

            try {
                await rbd.create(req.Name, size);
                createdImage = true;

                const device = await rbd.map(req.Name);
                mappedImage = true;

                await rbd.makeFilesystem(fstype, device);
                madeFilesystem = true;

                await rbd.unMap(req.Name);
            }
            catch (error) {
                /*
                    Roll back only what this request actually did. A failed create removes nothing (the
                    image may be someone else's existing one), a failed map removes the image but never
                    unmaps (this request owns no mapping), and a failed mkfs unmaps and trashes the
                    unusable image. A complete, formatted image whose final unmap failed is kept -
                    removing it would be data loss, and a later Mount finds it through isMapped.
                */
                if (createdImage && mappedImage && !madeFilesystem) {
                    await cleanupBestEffort(() => rbd.unMap(req.Name), `unmap volume ${req.Name}`);
                    await cleanupBestEffort(() => rbd.remove(req.Name), `remove volume ${req.Name}`);
                } else if (createdImage && !mappedImage) {
                    await cleanupBestEffort(() => rbd.remove(req.Name), `remove volume ${req.Name}`);
                }

                response.json({ Err: (error as Error).message });
                return;
            }

            response.json({
                Err: ""
            });
        });
    });

    /*
        Delete the specified volume from disk. This request is issued when a user invokes 
        docker rm -v to remove volumes associated with a container.
    */
    app.post("/VolumeDriver.Remove", async (request, response) => {
        const req = request.body as { Name: string };

        console.log(`Removing rbd volume ${req.Name}`);

        await volumeLock.withVolumeLock(req.Name, async () => {
            try {
                await rbd.unMap(req.Name);
                await rbd.remove(req.Name);
            }
            catch (error) {
                response.json({ Err: (error as Error).message });
                return;
            }

            response.json({
                Err: ""
            });
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

        await volumeLock.withVolumeLock(req.Name, async () => {
            if (mountPointTable.has(mountPoint)) {
                console.log(`${mountPoint} already mounted, nothing to do`);
                mountPointTable.get(mountPoint)!.references.push(req.ID);

                response.json({
                    MountPoint: mountPoint,
                    Err: ""
                });
                return;
            }

            /*
                Ownership is tracked from what this request actually did, not inferred from a later
                isMapped call: a mapping that isMapped already reported is not ours to unmap, while a
                mapping this request created (map resolved) is. map failing leaves us owning nothing.
            */
            let ownsMapping = false;

            try {
                let device = await rbd.isMapped(req.Name);

                if (!device) {
                    device = await rbd.map(req.Name);
                    ownsMapping = true;
                }

                await rbd.mount(device, mountPoint);
            }
            catch (error) {
                if (ownsMapping) {
                    await cleanupBestEffort(() => rbd.unMap(req.Name), `unmap volume ${req.Name}`);
                }

                // No mount point table entry is added below on this path, so a later Mount retries from scratch.
                response.json({ Err: (error as Error).message });
                return;
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

        await volumeLock.withVolumeLock(req.Name, async () => {
            if (!mountPointTable.has(mountPoint)) {
                const error = `Unknown volume ${req.Name}`;
                console.error(error);
                response.json({ Err: error });
                return;
            }

            let mountPointEntry = mountPointTable.get(mountPoint);

            if (!mountPointEntry) {
                const error = `Unknown volume ${req.Name}`;
                console.error(error);
                response.json({ Err: error });
                return;
            }

            if (!mountPointEntry.hasReference(req.ID)) {
                const error = `Unknown caller id ${req.ID} for volume ${req.Name}`;
                console.error(error);
                response.json({ Err: error });
                return;
            }

            const remainingIds = mountPointEntry.references.filter(id => id !== req.ID);

            if (remainingIds.length > 0) {
                console.log(`${remainingIds.length} references to volume ${req.Name} remaining, not unmounting..`);
                mountPointEntry.references = remainingIds;
                response.json({ Err: "" });
                return;
            }

            try {
                await rbd.unmount(mountPoint);
                mountPointTable.delete(mountPoint);
                await rbd.unMap(req.Name);
            }
            catch (error) {
                response.json({ Err: (error as Error).message });
                return;
            }

            response.json({
                Err: ""
            });
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
            return response.json({ Err: (error as Error).message });
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
                        Name: info.image,
                        Mountpoint: entry?.mountPoint || ""
                    };
                }),
                Err: ""
              });
        }
        catch (error) {
            return response.json({ Err: (error as Error).message });
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

    return app;
}
