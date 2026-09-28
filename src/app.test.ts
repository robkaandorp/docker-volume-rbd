import test, { after, afterEach, beforeEach } from "node:test";
import assert from "node:assert";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createApp, createVolumeLock, type RbdInterface } from "./app";

/*
    Stub Rbd: records every call and returns scripted results. createApp only needs the
    methods in RbdInterface, so a plain object is enough - no Ceph, no rbd binaries.
*/
type Call = { method: string, args: unknown[] };

/*
    A gate a test can hold a stubbed call open with. Blocking a call lets a test observe real
    concurrency: what a second request does while the first one is still inside the stub.
*/
class Gate {
    private readonly opened: Promise<void>;
    private release!: () => void;

    constructor() {
        this.opened = new Promise<void>(resolve => { this.release = resolve; });
    }

    wait(): Promise<void> {
        return this.opened;
    }

    open(): void {
        this.release();
    }
}

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

    /*
        Calls a test holds open, keyed by "<method>:<volume>". Blocking a specific volume's call
        lets a test observe real concurrency: what a second request does while the first one is
        still inside the stub. Calls without a gate run straight through.
    */
    readonly gates = new Map<string, Gate>();

    private record(method: string, args: unknown[], volume: string): void {
        this.calls.push({ method: method, args: args });

        const message = this.failWith[method];
        if (message !== undefined) {
            throw new Error(message);
        }
    }

    private async waitAtGate(method: string, volume: string): Promise<void> {
        await this.gates.get(`${method}:${volume}`)?.wait();
    }

    argsOf(method: string): unknown[][] {
        return this.calls.filter(call => call.method === method).map(call => call.args);
    }

    async create(name: string, size: string): Promise<void> {
        this.record("create", [name, size], name);
        await this.waitAtGate("create", name);
    }

    async map(name: string): Promise<string> {
        this.record("map", [name], name);
        await this.waitAtGate("map", name);
        return this.device;
    }

    async makeFilesystem(fstype: string, device: string): Promise<void> {
        this.record("makeFilesystem", [fstype, device], device);
        await this.waitAtGate("makeFilesystem", device);
    }

    async unMap(name: string): Promise<void> {
        this.record("unMap", [name], name);
        await this.waitAtGate("unMap", name);
    }

    async isMapped(name: string): Promise<string | null> {
        this.record("isMapped", [name], name);
        await this.waitAtGate("isMapped", name);
        return this.mapped;
    }

    async mount(device: string, mountPoint: string): Promise<void> {
        this.record("mount", [device, mountPoint], mountPoint);
        await this.waitAtGate("mount", mountPoint);
    }

    async unmount(mountPoint: string): Promise<void> {
        this.record("unmount", [mountPoint], mountPoint);
        await this.waitAtGate("unmount", mountPoint);
    }

    async remove(name: string): Promise<void> {
        this.record("remove", [name], name);
        await this.waitAtGate("remove", name);
    }

    async getInfo(name: string): Promise<{ image: string, id: string, size: number, format: number } | undefined> {
        this.record("getInfo", [name], name);
        return this.info;
    }

    async list(): Promise<{ image: string, id: string, size: number, format: number }[]> {
        this.record("list", [], "");
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

/*
    Concurrency helpers. Waiting for a condition is used for things that must happen (a request
    reaching a stubbed command); settling is used before asserting that something did NOT happen
    in the meantime.
*/
async function waitFor(condition: () => boolean, description: string): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt++) {
        if (condition()) {
            return;
        }

        await new Promise(resolve => setTimeout(resolve, 5));
    }

    assert.fail(`timed out waiting for ${description}`);
}

/** Gives in-flight requests a few event loop turns to do whatever they were going to do. */
async function settle(turns = 4): Promise<void> {
    for (let turn = 0; turn < turns; turn++) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

/*
    Awaits a promise, failing the test instead of hanging the run when it never settles. Without a
    deadline, a serialisation bug that deadlocks a request would hang the whole suite.
*/
async function within<T>(promise: Promise<T>, description: string, milliseconds = 5000): Promise<T> {
    let timer: NodeJS.Timeout | undefined;

    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${description}`)), milliseconds);
    });

    try {
        return await Promise.race([promise, deadline]);
    }
    finally {
        clearTimeout(timer);
    }
}

/*
    Opens every gate and waits for the given requests. Used in a finally block so a failing
    assertion can never leave a request hanging and keep the test server open. Gates are passed as
    the values of the stub's gate map.
*/
async function drain(gates: Iterable<Gate>, ...requests: Promise<unknown>[]): Promise<void> {
    for (const gate of gates) {
        gate.open();
    }

    await Promise.all(requests.map(request => request.catch(() => undefined)));
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

test("Create rolls back nothing when create fails", async () => {
    const port = await startApp();
    rbd.failWith.create = "image already exists";

    assert.deepStrictEqual(await post(port, "/VolumeDriver.Create", { Name: "volume1" }), {
        status: 200,
        body: { Err: "image already exists" },
    });

    // The image may be someone else's: neither the (non-existent) mapping nor the image is touched.
    assert.deepStrictEqual(rbd.calls, [{ method: "create", args: ["volume1", "200M"] }]);
});

test("Create removes the image when map fails", async () => {
    const port = await startApp();
    rbd.failWith.map = "no such image";

    assert.deepStrictEqual(await post(port, "/VolumeDriver.Create", { Name: "volume1" }), {
        status: 200,
        body: { Err: "no such image" },
    });

    // Nothing was mapped by this request, so it must not unmap.
    assert.deepStrictEqual(rbd.calls, [
        { method: "create", args: ["volume1", "200M"] },
        { method: "map", args: ["volume1"] },
        { method: "remove", args: ["volume1"] },
    ]);
});

test("Create unmaps and removes the image when makeFilesystem fails", async () => {
    const port = await startApp();
    rbd.failWith.makeFilesystem = "bad filesystem type";

    assert.deepStrictEqual(await post(port, "/VolumeDriver.Create", { Name: "volume1" }), {
        status: 200,
        body: { Err: "bad filesystem type" },
    });

    assert.deepStrictEqual(rbd.calls, [
        { method: "create", args: ["volume1", "200M"] },
        { method: "map", args: ["volume1"] },
        { method: "makeFilesystem", args: ["xfs", "/dev/rbd0"] },
        { method: "unMap", args: ["volume1"] },
        { method: "remove", args: ["volume1"] },
    ]);
});

test("Create keeps the complete image when only the final unMap fails", async () => {
    const port = await startApp();
    rbd.failWith.unMap = "device busy";

    assert.deepStrictEqual(await post(port, "/VolumeDriver.Create", { Name: "volume1" }), {
        status: 200,
        body: { Err: "device busy" },
    });

    // A formatted image must not be trashed, so there is no rollback and no retry of the unmap.
    assert.deepStrictEqual(rbd.calls, [
        { method: "create", args: ["volume1", "200M"] },
        { method: "map", args: ["volume1"] },
        { method: "makeFilesystem", args: ["xfs", "/dev/rbd0"] },
        { method: "unMap", args: ["volume1"] },
    ]);
});

test("a failing Create cleanup does not hide the original error", async () => {
    const port = await startApp();
    rbd.failWith.makeFilesystem = "bad filesystem type";
    rbd.failWith.unMap = "device busy";
    rbd.failWith.remove = "image busy";

    assert.deepStrictEqual(await post(port, "/VolumeDriver.Create", { Name: "volume1" }), {
        status: 200,
        body: { Err: "bad filesystem type" },
    });

    // Both cleanups are attempted, their failures only logged.
    assert.deepStrictEqual(rbd.argsOf("unMap"), [["volume1"]]);
    assert.deepStrictEqual(rbd.argsOf("remove"), [["volume1"]]);
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

test("a failed Mount unmaps the mapping it created and a retry starts from scratch", async () => {
    const port = await startApp();
    rbd.failWith.mount = "wrong fs type";

    assert.deepStrictEqual(await post(port, "/VolumeDriver.Mount", { Name: "volume1", ID: "id1" }), {
        status: 200,
        body: { Err: "wrong fs type" },
    });

    // The mapping was created by this request, so it is rolled back.
    assert.deepStrictEqual(rbd.calls, [
        { method: "isMapped", args: ["volume1"] },
        { method: "map", args: ["volume1"] },
        { method: "mount", args: ["/dev/rbd0", "/mnt/volumes/rbd/volume1"] },
        { method: "unMap", args: ["volume1"] },
    ]);

    // No stale mount point table entry: the volume is not reported as mounted.
    assert.deepStrictEqual(await post(port, "/VolumeDriver.Path", { Name: "volume1" }), {
        status: 200,
        body: { Err: "" },
    });

    // A retry goes through the whole isMapped/map/mount sequence again.
    rbd.failWith.mount = undefined;
    assert.deepStrictEqual(await post(port, "/VolumeDriver.Mount", { Name: "volume1", ID: "id1" }), {
        status: 200,
        body: { MountPoint: "/mnt/volumes/rbd/volume1", Err: "" },
    });
    assert.deepStrictEqual(rbd.argsOf("isMapped"), [["volume1"], ["volume1"]]);
    assert.deepStrictEqual(rbd.argsOf("map"), [["volume1"], ["volume1"]]);
});

test("a failed Mount of an already mapped volume does not unmap it", async () => {
    const port = await startApp();
    rbd.mapped = "/dev/rbd7";
    rbd.failWith.mount = "wrong fs type";

    assert.deepStrictEqual(await post(port, "/VolumeDriver.Mount", { Name: "volume1", ID: "id1" }), {
        status: 200,
        body: { Err: "wrong fs type" },
    });

    // The mapping belongs to someone else: this request must not unmap it.
    assert.deepStrictEqual(rbd.calls, [
        { method: "isMapped", args: ["volume1"] },
        { method: "mount", args: ["/dev/rbd7", "/mnt/volumes/rbd/volume1"] },
    ]);
});

test("a failed Mount does not unmap when map itself fails", async () => {
    const port = await startApp();
    rbd.failWith.map = "no such image";

    assert.deepStrictEqual(await post(port, "/VolumeDriver.Mount", { Name: "volume1", ID: "id1" }), {
        status: 200,
        body: { Err: "no such image" },
    });

    assert.deepStrictEqual(rbd.calls, [
        { method: "isMapped", args: ["volume1"] },
        { method: "map", args: ["volume1"] },
    ]);
});

test("a failing Mount cleanup does not hide the original error", async () => {
    const port = await startApp();
    rbd.failWith.mount = "wrong fs type";
    rbd.failWith.unMap = "device busy";

    assert.deepStrictEqual(await post(port, "/VolumeDriver.Mount", { Name: "volume1", ID: "id1" }), {
        status: 200,
        body: { Err: "wrong fs type" },
    });

    assert.deepStrictEqual(rbd.argsOf("unMap"), [["volume1"]]);
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

test("two concurrent Mounts of the same volume mount once and reference both IDs", async () => {
    const port = await startApp();

    // Hold the mount command open, so the second request has to queue behind the first one.
    const mountGate = new Gate();
    const mountKey = "mount:/mnt/volumes/rbd/volume1";
    rbd.gates.set(mountKey, mountGate);

    const first = post(port, "/VolumeDriver.Mount", { Name: "volume1", ID: "id1" });

    // Let the first request get as far as the (blocked) mount call before the second arrives.
    await waitFor(() => rbd.argsOf("mount").length === 1, "the first Mount to reach the mount command");

    const second = post(port, "/VolumeDriver.Mount", { Name: "volume1", ID: "id2" });

    try {
        // While the first Mount is still inside the stub, the queued request must not map or mount again.
        await settle();
        assert.deepStrictEqual(rbd.argsOf("map"), [["volume1"]], "the queued Mount must not map again");
        assert.deepStrictEqual(rbd.argsOf("mount"), [["/dev/rbd0", "/mnt/volumes/rbd/volume1"]]);

        mountGate.open();

        assert.deepStrictEqual(await within(first, "the first Mount"), {
            status: 200,
            body: { MountPoint: "/mnt/volumes/rbd/volume1", Err: "" },
        });
        assert.deepStrictEqual(await within(second, "the second, queued Mount"), {
            status: 200,
            body: { MountPoint: "/mnt/volumes/rbd/volume1", Err: "" },
        });
    } finally {
        await drain(rbd.gates.values(), first, second);
    }

    // Exactly one isMapped/map/mount sequence, and both IDs are referenced.
    assert.deepStrictEqual(rbd.calls, [
        { method: "isMapped", args: ["volume1"] },
        { method: "map", args: ["volume1"] },
        { method: "mount", args: ["/dev/rbd0", "/mnt/volumes/rbd/volume1"] },
    ]);

    // The second Mount must have been served from the table, so the volume now has two references:
    // unmounting id1 leaves it mounted for id2.
    assert.deepStrictEqual(await post(port, "/VolumeDriver.Unmount", { Name: "volume1", ID: "id1" }), {
        status: 200,
        body: { Err: "" },
    });
    assert.deepStrictEqual(rbd.argsOf("unmount"), []);
    assert.deepStrictEqual(await post(port, "/VolumeDriver.Path", { Name: "volume1" }), {
        status: 200,
        body: { MountPoint: "/mnt/volumes/rbd/volume1", Err: "" },
    });
    assert.deepStrictEqual(await post(port, "/VolumeDriver.Unmount", { Name: "volume1", ID: "id2" }), {
        status: 200,
        body: { Err: "" },
    });
    assert.deepStrictEqual(rbd.argsOf("unmount"), [["/mnt/volumes/rbd/volume1"]]);
});

test("concurrent operations on different volumes are not serialised", async () => {
    const port = await startApp();

    // Each volume blocks inside its own create call.
    const firstGate = new Gate();
    const secondGate = new Gate();
    rbd.gates.set("create:volume1", firstGate);
    rbd.gates.set("create:volume2", secondGate);

    const first = post(port, "/VolumeDriver.Create", { Name: "volume1" });
    const second = post(port, "/VolumeDriver.Create", { Name: "volume2" });

    try {
        // Both creates are in flight at the same time: neither volume's lock blocks the other.
        await waitFor(() => rbd.argsOf("create").length === 2, "both volumes to reach the create command");
        assert.deepStrictEqual(rbd.argsOf("create"), [["volume1", "200M"], ["volume2", "200M"]]);

        // The second volume even finishes while the first one is still blocked.
        secondGate.open();
        assert.deepStrictEqual(await within(second, "the second volume's Create"), { status: 200, body: { Err: "" } });

        firstGate.open();
        assert.deepStrictEqual(await within(first, "the first volume's Create"), { status: 200, body: { Err: "" } });
    } finally {
        await drain(rbd.gates.values(), first, second);
    }

    // Both creates ran to completion independently.
    assert.deepStrictEqual(rbd.argsOf("makeFilesystem"), [
        ["xfs", "/dev/rbd0"],
        ["xfs", "/dev/rbd0"],
    ]);
});

test("a failed operation does not block the next operation on the same volume", async () => {
    const port = await startApp();
    rbd.failWith.create = "image already exists";

    assert.deepStrictEqual(await post(port, "/VolumeDriver.Create", { Name: "volume1" }), {
        status: 200,
        body: { Err: "image already exists" },
    });

    // The rejected operation must leave the queue usable: the next request on the volume still runs.
    rbd.failWith.create = undefined;
    assert.deepStrictEqual(await post(port, "/VolumeDriver.Create", { Name: "volume1" }), {
        status: 200,
        body: { Err: "" },
    });
    assert.deepStrictEqual(rbd.argsOf("create"), [["volume1", "200M"], ["volume1", "200M"]]);

    // A failing Mount that rolls back does not block a retry either.
    rbd.failWith.mount = "wrong fs type";
    assert.deepStrictEqual(await post(port, "/VolumeDriver.Mount", { Name: "volume1", ID: "id1" }), {
        status: 200,
        body: { Err: "wrong fs type" },
    });

    rbd.failWith.mount = undefined;
    assert.deepStrictEqual(await post(port, "/VolumeDriver.Mount", { Name: "volume1", ID: "id1" }), {
        status: 200,
        body: { MountPoint: "/mnt/volumes/rbd/volume1", Err: "" },
    });
});

test("the volume lock runs same-volume operations in order and differently-named ones in parallel", async () => {
    // The lock itself, without an HTTP round trip. Timings are not asserted, only ordering.
    const lock = createVolumeLock();
    const order: string[] = [];

    // The first operation is held open until the test releases it, so "did the second one start
    // early?" is decided by the lock, not by how fast the machine is.
    const firstGate = new Gate();

    const first = lock.withVolumeLock("volume1", async () => {
        order.push("first:start");
        await firstGate.wait();
        order.push("first:end");
    });

    const second = lock.withVolumeLock("volume1", async () => {
        order.push("second:start");
        order.push("second:end");
    });

    const other = lock.withVolumeLock("volume2", async () => {
        order.push("other:start");
        order.push("other:end");
    });

    // The other volume and the queued same-volume operation behave in opposite ways.
    await within(other, "the other volume's operation");
    assert.ok(order.includes("first:start"), "the first operation must have started");
    assert.ok(order.includes("other:end"), "a different volume must run while the first volume is still locked");
    assert.ok(!order.includes("second:start"), "the queued operation must not start while the volume is locked");

    firstGate.open();
    await within(Promise.all([first, second]), "the volume1 chain to drain");

    // Same volume: the second operation starts only after the first one finished.
    assert.deepStrictEqual(order.filter(step => step.startsWith("first") || step.startsWith("second")),
        ["first:start", "first:end", "second:start", "second:end"]);

    // A different volume started without waiting for volume1.
    assert.ok(order.indexOf("other:start") < order.indexOf("first:end"),
        "an operation on another volume must not wait for the first volume");

    // No chain entry is left behind once every operation finished.
    assert.strictEqual(lock.pendingVolumes(), 0);
});

test("the volume lock keeps working after a rejected operation", async () => {
    const lock = createVolumeLock();
    const firstGate = new Gate();
    const ran: string[] = [];

    const failed = lock.withVolumeLock("volume1", async () => {
        await firstGate.wait();
        ran.push("failed");
        throw new Error("boom");
    });

    // Queued BEFORE the first operation rejects: a rejected predecessor must not poison the queue.
    const next = lock.withVolumeLock("volume1", async () => {
        ran.push("next");
    });

    firstGate.open();

    // The caller still sees its own rejection...
    await assert.rejects(() => failed, { message: "boom" });

    // ...while the operation queued behind it still runs.
    await within(next, "the operation queued after a failure");
    assert.deepStrictEqual(ran, ["failed", "next"]);

    // And the map was cleaned up afterwards.
    assert.strictEqual(lock.pendingVolumes(), 0);
});

test("the volume lock drops its entry once a volume's chain is done", async () => {
    const lock = createVolumeLock();
    let release!: () => void;
    const running = lock.withVolumeLock("volume1", () => new Promise<void>(resolve => { release = resolve; }));

    await waitFor(() => lock.pendingVolumes() === 1, "the volume to be locked");
    assert.strictEqual(lock.pendingVolumes(), 1);

    release();
    await running;

    // The entry must be gone, so a long-lived app cannot accumulate one entry per volume ever seen.
    await waitFor(() => lock.pendingVolumes() === 0, "the lock entry to be dropped");
    assert.strictEqual(lock.pendingVolumes(), 0);
});
