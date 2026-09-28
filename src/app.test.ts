import test, { after, afterEach, beforeEach } from "node:test";
import assert from "node:assert";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createApp, type RbdInterface } from "./app";

/*
    Stub Rbd: records every call and returns scripted results. createApp only needs the
    methods in RbdInterface, so a plain object is enough - no Ceph, no rbd binaries.
*/
type Call = { method: string, args: unknown[] };

class StubRbd implements RbdInterface {
    readonly calls: Call[] = [];

    /** Device returned by map(). */
    device = "/dev/rbd0";

    /** Result of isMapped(); null means "not mapped yet". */
    mapped: string | null = null;

    /** Result of getInfo(); undefined means "unknown volume". */
    info: { image: string, id: string, size: number, format: number } | undefined =
        { image: "volume1", id: "1", size: 1073741824, format: 2 };

    /** Result of list(). */
    images: { image: string, id: string, size: number, format: number }[] = [];

    /** Set to make any of the recorded methods throw. */
    failWith: Partial<Record<Call["method"], string>> = {};

    private record(method: string, args: unknown[]): void {
        this.calls.push({ method: method, args: args });

        const message = this.failWith[method];
        if (message !== undefined) {
            throw new Error(message);
        }
    }

    argsOf(method: string): unknown[][] {
        return this.calls.filter(call => call.method === method).map(call => call.args);
    }

    async create(name: string, size: string): Promise<void> {
        this.record("create", [name, size]);
    }

    async map(name: string): Promise<string> {
        this.record("map", [name]);
        return this.device;
    }

    async makeFilesystem(fstype: string, device: string): Promise<void> {
        this.record("makeFilesystem", [fstype, device]);
    }

    async unMap(name: string): Promise<void> {
        this.record("unMap", [name]);
    }

    async isMapped(name: string): Promise<string | null> {
        this.record("isMapped", [name]);
        return this.mapped;
    }

    async mount(device: string, mountPoint: string): Promise<void> {
        this.record("mount", [device, mountPoint]);
    }

    async unmount(mountPoint: string): Promise<void> {
        this.record("unmount", [mountPoint]);
    }

    async remove(name: string): Promise<void> {
        this.record("remove", [name]);
    }

    async getInfo(name: string): Promise<{ image: string, id: string, size: number, format: number } | undefined> {
        this.record("getInfo", [name]);
        return this.info;
    }

    async list(): Promise<{ image: string, id: string, size: number, format: number }[]> {
        this.record("list", []);
        return this.images;
    }
}

let rbd: StubRbd;
let openServers: Server[];
const allServers: Server[] = [];

/* The app logs every request; keep the test output readable. */
const realConsoleLog = console.log;
const realConsoleError = console.error;
beforeEach(() => {
    rbd = new StubRbd();
    openServers = [];
    console.log = () => { };
    console.error = () => { };
});
afterEach(async () => {
    console.log = realConsoleLog;
    console.error = realConsoleError;

    // Close every server that is still open so the test process can exit.
    await Promise.all(openServers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    openServers = [];
});
after(() => {
    // Every server started by any test must have been closed by its teardown.
    assert.deepStrictEqual(allServers.map(server => server.listening), allServers.map(() => false),
        "every test server must be closed");
});

/** Starts a fresh app on an ephemeral port and returns its port. */
async function startApp(pool = "rbd"): Promise<number> {
    const app = createApp(rbd, pool);

    const server = await new Promise<Server>(resolve => {
        const listening = app.listen(0, () => resolve(listening));
    });
    openServers.push(server);
    allServers.push(server);

    return (server.address() as AddressInfo).port;
}

async function post(port: number, route: string, body?: unknown): Promise<{ status: number, body: unknown }> {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
    });

    return { status: response.status, body: await response.json() };
}

test("Plugin.Activate implements the volume driver", async () => {
    const port = await startApp();

    assert.deepStrictEqual(await post(port, "/Plugin.Activate"), {
        status: 200,
        body: { Implements: ["VolumeDriver"] },
    });
});

test("Capabilities has global scope", async () => {
    const port = await startApp();

    assert.deepStrictEqual(await post(port, "/VolumeDriver.Capabilities"), {
        status: 200,
        body: { Capabilities: { Scope: "global" } },
    });
});

test("the json middleware parses the body for any content type", async () => {
    const port = await startApp();

    const response = await fetch(`http://127.0.0.1:${port}/VolumeDriver.Mount`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ Name: "volume1", ID: "id1" }),
    });

    assert.deepStrictEqual(await response.json(), { MountPoint: "/mnt/volumes/rbd/volume1", Err: "" });
});

test("Create creates, maps, makes a filesystem and unmaps", async () => {
    const port = await startApp();

    assert.deepStrictEqual(await post(port, "/VolumeDriver.Create", { Name: "volume1", Opts: { size: "1G", fstype: "ext4" } }), {
        status: 200,
        body: { Err: "" },
    });

    assert.deepStrictEqual(rbd.calls, [
        { method: "create", args: ["volume1", "1G"] },
        { method: "map", args: ["volume1"] },
        { method: "makeFilesystem", args: ["ext4", "/dev/rbd0"] },
        { method: "unMap", args: ["volume1"] },
    ]);
});

test("Create defaults to a 200M xfs filesystem", async () => {
    const port = await startApp();

    assert.deepStrictEqual(await post(port, "/VolumeDriver.Create", { Name: "volume1" }), {
        status: 200,
        body: { Err: "" },
    });

    assert.deepStrictEqual(rbd.argsOf("create"), [["volume1", "200M"]]);
    assert.deepStrictEqual(rbd.argsOf("makeFilesystem"), [["xfs", "/dev/rbd0"]]);
});

test("Create maps an error to Err", async () => {
    const port = await startApp();
    rbd.failWith.create = "image already exists";

    assert.deepStrictEqual(await post(port, "/VolumeDriver.Create", { Name: "volume1" }), {
        status: 200,
        body: { Err: "image already exists" },
    });
});

test("Remove unmaps and trashes the volume", async () => {
    const port = await startApp();

    assert.deepStrictEqual(await post(port, "/VolumeDriver.Remove", { Name: "volume1" }), {
        status: 200,
        body: { Err: "" },
    });

    assert.deepStrictEqual(rbd.calls, [
        { method: "unMap", args: ["volume1"] },
        { method: "remove", args: ["volume1"] },
    ]);
});

test("Remove maps an error to Err", async () => {
    const port = await startApp();
    rbd.failWith.remove = "not found";

    assert.deepStrictEqual(await post(port, "/VolumeDriver.Remove", { Name: "volume1" }), {
        status: 200,
        body: { Err: "not found" },
    });
});

test("Mount maps and mounts the volume", async () => {
    const port = await startApp();

    assert.deepStrictEqual(await post(port, "/VolumeDriver.Mount", { Name: "volume1", ID: "id1" }), {
        status: 200,
        body: { MountPoint: "/mnt/volumes/rbd/volume1", Err: "" },
    });

    assert.deepStrictEqual(rbd.calls, [
        { method: "isMapped", args: ["volume1"] },
        { method: "map", args: ["volume1"] },
        { method: "mount", args: ["/dev/rbd0", "/mnt/volumes/rbd/volume1"] },
    ]);
});

test("Mount reuses the device when the volume is already mapped", async () => {
    const port = await startApp();
    rbd.mapped = "/dev/rbd7";

    assert.deepStrictEqual(await post(port, "/VolumeDriver.Mount", { Name: "volume1", ID: "id1" }), {
        status: 200,
        body: { MountPoint: "/mnt/volumes/rbd/volume1", Err: "" },
    });

    assert.deepStrictEqual(rbd.argsOf("map"), []);
    assert.deepStrictEqual(rbd.argsOf("mount"), [["/dev/rbd7", "/mnt/volumes/rbd/volume1"]]);
});

test("Mount uses the mount point of the configured pool", async () => {
    const port = await startApp("mypool");

    assert.deepStrictEqual(await post(port, "/VolumeDriver.Mount", { Name: "volume1", ID: "id1" }), {
        status: 200,
        body: { MountPoint: "/mnt/volumes/mypool/volume1", Err: "" },
    });
});

test("Mount maps an error to Err", async () => {
    const port = await startApp();
    rbd.failWith.mount = "wrong fs type";

    assert.deepStrictEqual(await post(port, "/VolumeDriver.Mount", { Name: "volume1", ID: "id1" }), {
        status: 200,
        body: { Err: "wrong fs type" },
    });
});

test("two Mounts with different IDs only mount once", async () => {
    const port = await startApp();

    const first = await post(port, "/VolumeDriver.Mount", { Name: "volume1", ID: "id1" });
    const second = await post(port, "/VolumeDriver.Mount", { Name: "volume1", ID: "id2" });

    assert.deepStrictEqual(first.body, { MountPoint: "/mnt/volumes/rbd/volume1", Err: "" });
    assert.deepStrictEqual(second.body, { MountPoint: "/mnt/volumes/rbd/volume1", Err: "" });

    // The second Mount is served from the mount point table.
    assert.deepStrictEqual(rbd.calls, [
        { method: "isMapped", args: ["volume1"] },
        { method: "map", args: ["volume1"] },
        { method: "mount", args: ["/dev/rbd0", "/mnt/volumes/rbd/volume1"] },
    ]);
});

test("the first Unmount leaves the volume mounted and the second unmounts it", async () => {
    const port = await startApp();
    await post(port, "/VolumeDriver.Mount", { Name: "volume1", ID: "id1" });
    await post(port, "/VolumeDriver.Mount", { Name: "volume1", ID: "id2" });

    assert.deepStrictEqual(await post(port, "/VolumeDriver.Unmount", { Name: "volume1", ID: "id1" }), {
        status: 200,
        body: { Err: "" },
    });
    assert.deepStrictEqual(rbd.argsOf("unmount"), []);
    assert.deepStrictEqual(rbd.argsOf("unMap"), []);

    // Still mounted, so Path still reports the mount point.
    assert.deepStrictEqual(await post(port, "/VolumeDriver.Path", { Name: "volume1" }), {
        status: 200,
        body: { MountPoint: "/mnt/volumes/rbd/volume1", Err: "" },
    });

    assert.deepStrictEqual(await post(port, "/VolumeDriver.Unmount", { Name: "volume1", ID: "id2" }), {
        status: 200,
        body: { Err: "" },
    });
    assert.deepStrictEqual(rbd.argsOf("unmount"), [["/mnt/volumes/rbd/volume1"]]);
    assert.deepStrictEqual(rbd.argsOf("unMap"), [["volume1"]]);

    // Unmounted now, so the volume is no longer in the mount point table.
    assert.deepStrictEqual(await post(port, "/VolumeDriver.Path", { Name: "volume1" }), {
        status: 200,
        body: { Err: "" },
    });
});

test("Unmount can be called without a preceding Mount", async () => {
    const port = await startApp();

    assert.deepStrictEqual(await post(port, "/VolumeDriver.Unmount", { Name: "volume1", ID: "id1" }), {
        status: 200,
        body: { Err: "Unknown volume volume1" },
    });

    assert.deepStrictEqual(rbd.calls, []);
});

test("Unmount of an unknown volume returns an Err", async () => {
    const port = await startApp();
    await post(port, "/VolumeDriver.Mount", { Name: "volume1", ID: "id1" });

    assert.deepStrictEqual(await post(port, "/VolumeDriver.Unmount", { Name: "othervolume", ID: "id1" }), {
        status: 200,
        body: { Err: "Unknown volume othervolume" },
    });
});

test("Unmount with an unknown caller ID returns an Err and keeps the volume mounted", async () => {
    const port = await startApp();
    await post(port, "/VolumeDriver.Mount", { Name: "volume1", ID: "id1" });

    assert.deepStrictEqual(await post(port, "/VolumeDriver.Unmount", { Name: "volume1", ID: "otherid" }), {
        status: 200,
        body: { Err: "Unknown caller id otherid for volume volume1" },
    });

    assert.deepStrictEqual(rbd.argsOf("unmount"), []);
    assert.deepStrictEqual(await post(port, "/VolumeDriver.Path", { Name: "volume1" }), {
        status: 200,
        body: { MountPoint: "/mnt/volumes/rbd/volume1", Err: "" },
    });
});

test("Unmount maps an error to Err", async () => {
    const port = await startApp();
    await post(port, "/VolumeDriver.Mount", { Name: "volume1", ID: "id1" });
    rbd.failWith.unmount = "device busy";

    assert.deepStrictEqual(await post(port, "/VolumeDriver.Unmount", { Name: "volume1", ID: "id1" }), {
        status: 200,
        body: { Err: "device busy" },
    });
});

test("Path returns an empty Err when the volume is not mounted", async () => {
    const port = await startApp();

    assert.deepStrictEqual(await post(port, "/VolumeDriver.Path", { Name: "volume1" }), {
        status: 200,
        body: { Err: "" },
    });
});

test("Path returns the mount point when the volume is mounted", async () => {
    const port = await startApp();
    await post(port, "/VolumeDriver.Mount", { Name: "volume1", ID: "id1" });

    assert.deepStrictEqual(await post(port, "/VolumeDriver.Path", { Name: "volume1" }), {
        status: 200,
        body: { MountPoint: "/mnt/volumes/rbd/volume1", Err: "" },
    });
});

test("List returns the image names", async () => {
    const port = await startApp();
    rbd.images = [
        { image: "volume1", id: "1", size: 1073741824, format: 2 },
        { image: "volume2", id: "2", size: 2097152, format: 2 },
    ];

    assert.deepStrictEqual(await post(port, "/VolumeDriver.List"), {
        status: 200,
        body: {
            Volumes: [
                { Name: "volume1", Mountpoint: "" },
                { Name: "volume2", Mountpoint: "" },
            ],
            Err: "",
        },
    });
});

test("List reports the mount point of mounted volumes", async () => {
    const port = await startApp();
    rbd.images = [
        { image: "volume1", id: "1", size: 1073741824, format: 2 },
        { image: "volume2", id: "2", size: 2097152, format: 2 },
    ];
    await post(port, "/VolumeDriver.Mount", { Name: "volume1", ID: "id1" });

    assert.deepStrictEqual(await post(port, "/VolumeDriver.List"), {
        status: 200,
        body: {
            Volumes: [
                { Name: "volume1", Mountpoint: "/mnt/volumes/rbd/volume1" },
                { Name: "volume2", Mountpoint: "" },
            ],
            Err: "",
        },
    });
});

test("List maps an error to Err", async () => {
    const port = await startApp();
    rbd.failWith.list = "cluster unreachable";

    assert.deepStrictEqual(await post(port, "/VolumeDriver.List"), {
        status: 200,
        body: { Err: "cluster unreachable" },
    });
});

test("Get returns the size of the volume", async () => {
    const port = await startApp();

    assert.deepStrictEqual(await post(port, "/VolumeDriver.Get", { Name: "volume1" }), {
        status: 200,
        body: {
            Volume: {
                Name: "volume1",
                Mountpoint: "",
                Status: { size: 1073741824 },
            },
            Err: "",
        },
    });
});

test("Get returns the mount point of a mounted volume", async () => {
    const port = await startApp();
    await post(port, "/VolumeDriver.Mount", { Name: "volume1", ID: "id1" });

    assert.deepStrictEqual(await post(port, "/VolumeDriver.Get", { Name: "volume1" }), {
        status: 200,
        body: {
            Volume: {
                Name: "volume1",
                Mountpoint: "/mnt/volumes/rbd/volume1",
                Status: { size: 1073741824 },
            },
            Err: "",
        },
    });
});

test("Get returns an empty Err for an unknown volume", async () => {
    const port = await startApp();
    rbd.info = undefined;

    assert.deepStrictEqual(await post(port, "/VolumeDriver.Get", { Name: "unknown" }), {
        status: 200,
        body: { Err: "" },
    });
});

test("Get maps an error to Err", async () => {
    const port = await startApp();
    rbd.failWith.getInfo = "cluster unreachable";

    assert.deepStrictEqual(await post(port, "/VolumeDriver.Get", { Name: "volume1" }), {
        status: 200,
        body: { Err: "cluster unreachable" },
    });
});

test("each app has its own mount point table", async () => {
    const firstPort = await startApp();
    await post(firstPort, "/VolumeDriver.Mount", { Name: "volume1", ID: "id1" });

    // A second app must not see the mount registered by the first one.
    const secondPort = await startApp();

    assert.deepStrictEqual(await post(secondPort, "/VolumeDriver.Path", { Name: "volume1" }), {
        status: 200,
        body: { Err: "" },
    });
    assert.deepStrictEqual(await post(firstPort, "/VolumeDriver.Path", { Name: "volume1" }), {
        status: 200,
        body: { MountPoint: "/mnt/volumes/rbd/volume1", Err: "" },
    });
});
