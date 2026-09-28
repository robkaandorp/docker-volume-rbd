import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";

import Rbd, { type CommandRunner, type FileSystem } from "./rbd";

type RunnerCall = { file: string, args: string[], options: { timeout: number } };
type Output = { stdout: string, stderr: string };

/*
    Fake command runner: records every call and returns scripted output. It never
    executes anything, so the tests don't need rbd/mount/mkfs/umount binaries.
*/
class FakeRunner {
    readonly calls: RunnerCall[] = [];

    private readonly scripted: (Output | Error)[] = [];

    /** Queue the result of the next command. */
    next(output: Partial<Output>): FakeRunner {
        this.scripted.push({ stdout: "", stderr: "", ...output });
        return this;
    }

    /** Queue a rejection for the next command, like a failing execFile does. */
    nextFailure(code: number | string, message: string): FakeRunner {
        this.scripted.push(Object.assign(new Error(message), { code: code }));
        return this;
    }

    get run(): CommandRunner {
        return async (file, args, options) => {
            this.calls.push({ file: file, args: args, options: options });

            const scripted = this.scripted.shift();

            if (scripted instanceof Error) {
                throw scripted;
            }

            return scripted ?? { stdout: "", stderr: "" };
        };
    }

    get lastCall(): RunnerCall {
        return this.calls[this.calls.length - 1];
    }
}

/* Fake filesystem: records calls so the tests never create or remove anything. */
class FakeFileSystem {
    readonly calls: string[][] = [];

    /** Paths the fake filesystem reports as existing, like a mount point left over from before. */
    readonly existing = new Set<string>();

    /** Paths existsSync was asked about, kept apart from calls to keep assertions focused. */
    readonly existsCalls: string[] = [];

    /** Set to make every rmdirSync fail, like a directory that cannot be removed. */
    failRmdirWith: string | undefined;

    readonly fs: FileSystem = {
        existsSync: (path: string) => {
            this.existsCalls.push(path);
            return this.existing.has(path);
        },
        mkdirSync: (path: string, options: { recursive: true }) => {
            this.calls.push(["mkdirSync", path, JSON.stringify(options)]);
            this.existing.add(path);
        },
        rmdirSync: (path: string) => {
            this.calls.push(["rmdirSync", path]);

            if (this.failRmdirWith !== undefined) {
                throw new Error(this.failRmdirWith);
            }

            this.existing.delete(path);
        },
    };
}

const showmappedOutput = (entries: { pool: string, name: string, device: string }[]) => JSON.stringify(entries);

let runner: FakeRunner;
let fileSystem: FakeFileSystem;

beforeEach(() => {
    runner = new FakeRunner();
    fileSystem = new FakeFileSystem();
});

/* The source logs command output and errors; keep the test output readable. */
const realConsoleLog = console.log;
const realConsoleError = console.error;
beforeEach(() => {
    console.log = () => { };
    console.error = () => { };
});
afterEach(() => {
    console.log = realConsoleLog;
    console.error = realConsoleError;
});

function createRbd(options: { pool: string, cluster?: string, user?: string, map_options: string[] } = { pool: "rbd", map_options: ["--exclusive"] }): Rbd {
    return new Rbd(options, runner.run, fileSystem.fs);
}

test("create runs rbd create with the pool, name and size", async () => {
    const rbd = createRbd({ pool: "mypool", map_options: ["--exclusive"] });

    await rbd.create("volume1", "1G");

    assert.deepStrictEqual(runner.calls, [
        { file: "rbd", args: ["create", "--pool", "mypool", "volume1", "--size", "1G"], options: { timeout: 30000 } },
    ]);
});

test("map runs rbd map with the configured map options", async () => {
    const rbd = createRbd({ pool: "mypool", map_options: ["--exclusive", "--read-only"] });

    runner.next({ stdout: "/dev/rbd0\n" });
    const device = await rbd.map("volume1");

    assert.strictEqual(device, "/dev/rbd0");
    assert.deepStrictEqual(runner.calls, [
        { file: "rbd", args: ["map", "--exclusive", "--read-only", "--pool", "mypool", "volume1"], options: { timeout: 30000 } },
    ]);
});

test("map without map options passes no extra arguments", async () => {
    const rbd = createRbd({ pool: "mypool", map_options: [] });

    runner.next({ stdout: "/dev/rbd0\n" });
    await rbd.map("volume1");

    assert.deepStrictEqual(runner.lastCall.args, ["map", "--pool", "mypool", "volume1"]);
});

test("isMapped returns the device of the matching pool and name", async () => {
    const rbd = createRbd({ pool: "mypool", map_options: [] });

    runner.next({ stdout: showmappedOutput([
        { pool: "otherpool", name: "volume1", device: "/dev/rbd9" },
        { pool: "mypool", name: "volume1", device: "/dev/rbd0" },
    ]) });

    const device = await rbd.isMapped("volume1");

    assert.strictEqual(device, "/dev/rbd0");
    assert.deepStrictEqual(runner.calls, [
        { file: "rbd", args: ["showmapped", "--format", "json"], options: { timeout: 30000 } },
    ]);
});

test("isMapped returns null when the volume is not mapped", async () => {
    const rbd = createRbd({ pool: "mypool", map_options: [] });

    runner.next({ stdout: showmappedOutput([]) });

    assert.strictEqual(await rbd.isMapped("volume1"), null);
});

test("unMap runs rbd unmap when the volume is mapped", async () => {
    const rbd = createRbd({ pool: "mypool", map_options: [] });

    runner.next({ stdout: showmappedOutput([{ pool: "mypool", name: "volume1", device: "/dev/rbd0" }]) });
    runner.next({ stdout: "unmapped\n" });

    await rbd.unMap("volume1");

    assert.deepStrictEqual(runner.calls, [
        { file: "rbd", args: ["showmapped", "--format", "json"], options: { timeout: 30000 } },
        { file: "rbd", args: ["unmap", "--pool", "mypool", "volume1"], options: { timeout: 30000 } },
    ]);
});

test("unMap does not run rbd unmap when the volume is not mapped", async () => {
    const rbd = createRbd({ pool: "mypool", map_options: [] });

    runner.next({ stdout: showmappedOutput([{ pool: "mypool", name: "othervolume", device: "/dev/rbd1" }]) });

    await rbd.unMap("volume1");

    assert.deepStrictEqual(runner.calls.map(call => call.args), [["showmapped", "--format", "json"]]);
});

test("unMap does not run rbd unmap when the pool differs", async () => {
    const rbd = createRbd({ pool: "mypool", map_options: [] });

    runner.next({ stdout: showmappedOutput([{ pool: "otherpool", name: "volume1", device: "/dev/rbd0" }]) });

    await rbd.unMap("volume1");

    assert.deepStrictEqual(runner.calls.map(call => call.args), [["showmapped", "--format", "json"]]);
});

test("list runs rbd list and returns the parsed output", async () => {
    const rbd = createRbd({ pool: "mypool", map_options: [] });

    const images = [{ image: "volume1", id: "1", size: 1073741824, format: 2 }];
    runner.next({ stdout: JSON.stringify(images) });

    assert.deepStrictEqual(await rbd.list(), images);
    assert.deepStrictEqual(runner.calls, [
        { file: "rbd", args: ["list", "--pool", "mypool", "--long", "--format", "json"], options: { timeout: 30000 } },
    ]);
});

test("getInfo returns the entry matching the image name", async () => {
    const rbd = createRbd({ pool: "mypool", map_options: [] });

    const images = [
        { image: "othervolume", id: "1", size: 1073741824, format: 2 },
        { image: "volume1", id: "2", size: 2097152, format: 2 },
    ];
    runner.next({ stdout: JSON.stringify(images) });

    assert.deepStrictEqual(await rbd.getInfo("volume1"), { image: "volume1", id: "2", size: 2097152, format: 2 });
});

test("getInfo returns undefined for an unknown image", async () => {
    const rbd = createRbd({ pool: "mypool", map_options: [] });

    runner.next({ stdout: JSON.stringify([]) });

    assert.strictEqual(await rbd.getInfo("volume1"), undefined);
});

test("remove moves the image to the trash", async () => {
    const rbd = createRbd({ pool: "mypool", map_options: [] });

    runner.next({ stdout: "moved\n" });

    await rbd.remove("volume1");

    assert.deepStrictEqual(runner.calls, [
        { file: "rbd", args: ["trash", "move", "--pool", "mypool", "volume1"], options: { timeout: 30000 } },
    ]);
});

test("makeFilesystem runs mkfs with the filesystem type and device", async () => {
    const rbd = createRbd({ pool: "mypool", map_options: [] });

    await rbd.makeFilesystem("xfs", "/dev/rbd0");

    assert.deepStrictEqual(runner.calls, [
        { file: "mkfs", args: ["-t", "xfs", "/dev/rbd0"], options: { timeout: 120000 } },
    ]);
});

test("mount creates the mount point and mounts the device", async () => {
    const rbd = createRbd({ pool: "mypool", map_options: [] });
    const existedBefore = fs.existsSync("/mnt/volumes/mypool");

    await rbd.mount("/dev/rbd0", "/mnt/volumes/mypool/volume1");

    assert.deepStrictEqual(fileSystem.calls, [["mkdirSync", "/mnt/volumes/mypool/volume1", '{"recursive":true}']]);
    assert.deepStrictEqual(runner.calls, [
        { file: "mount", args: ["/dev/rbd0", "/mnt/volumes/mypool/volume1"], options: { timeout: 30000 } },
    ]);
    assert.strictEqual(fs.existsSync("/mnt/volumes/mypool"), existedBefore, "must not touch the real filesystem");
});

test("unmount unmounts the mount point and removes it", async () => {
    const rbd = createRbd({ pool: "mypool", map_options: [] });
    const existedBefore = fs.existsSync("/mnt/volumes/mypool");

    await rbd.unmount("/mnt/volumes/mypool/volume1");

    assert.deepStrictEqual(runner.calls, [
        { file: "umount", args: ["/mnt/volumes/mypool/volume1"], options: { timeout: 30000 } },
    ]);
    assert.deepStrictEqual(fileSystem.calls, [["rmdirSync", "/mnt/volumes/mypool/volume1"]]);
    assert.strictEqual(fs.existsSync("/mnt/volumes/mypool"), existedBefore, "must not touch the real filesystem");
});

test("no --cluster or --id arguments when cluster and user are unset", async () => {
    const rbd = createRbd({ pool: "mypool", map_options: [] });

    await rbd.create("volume1", "1G");
    runner.next({ stdout: showmappedOutput([]) });
    await rbd.unMap("volume1");
    runner.next({ stdout: showmappedOutput([]) });
    await rbd.isMapped("volume1");
    runner.next({ stdout: "[]" });
    await rbd.list();
    await rbd.remove("volume1");
    runner.next({ stdout: "/dev/rbd0\n" });
    await rbd.map("volume1");

    assert.deepStrictEqual(runner.calls.map(call => call.args), [
        ["create", "--pool", "mypool", "volume1", "--size", "1G"],
        ["showmapped", "--format", "json"],
        ["showmapped", "--format", "json"],
        ["list", "--pool", "mypool", "--long", "--format", "json"],
        ["trash", "move", "--pool", "mypool", "volume1"],
        ["map", "--pool", "mypool", "volume1"],
    ]);
});

test("--cluster and --id arguments are passed to every rbd command when set", async () => {
    const rbd = createRbd({ pool: "mypool", cluster: "ceph2", user: "admin", map_options: [] });

    await rbd.create("volume1", "1G");
    runner.next({ stdout: showmappedOutput([{ pool: "mypool", name: "volume1", device: "/dev/rbd0" }]) });
    runner.next({ stdout: "unmapped\n" });
    await rbd.unMap("volume1");
    runner.next({ stdout: showmappedOutput([]) });
    await rbd.isMapped("volume1");
    runner.next({ stdout: "[]" });
    await rbd.list();
    await rbd.remove("volume1");
    runner.next({ stdout: "/dev/rbd0\n" });
    await rbd.map("volume1");

    assert.deepStrictEqual(runner.calls.map(call => call.args), [
        ["--cluster", "ceph2", "--id", "admin", "create", "--pool", "mypool", "volume1", "--size", "1G"],
        ["--cluster", "ceph2", "--id", "admin", "showmapped", "--format", "json"],
        ["--cluster", "ceph2", "--id", "admin", "unmap", "--pool", "mypool", "volume1"],
        ["--cluster", "ceph2", "--id", "admin", "showmapped", "--format", "json"],
        ["--cluster", "ceph2", "--id", "admin", "list", "--pool", "mypool", "--long", "--format", "json"],
        ["--cluster", "ceph2", "--id", "admin", "trash", "move", "--pool", "mypool", "volume1"],
        ["--cluster", "ceph2", "--id", "admin", "map", "--pool", "mypool", "volume1"],
    ]);
});

test("only --cluster is passed when the user is unset", async () => {
    const rbd = createRbd({ pool: "mypool", cluster: "ceph2", map_options: [] });

    await rbd.create("volume1", "1G");

    assert.deepStrictEqual(runner.lastCall.args, ["--cluster", "ceph2", "create", "--pool", "mypool", "volume1", "--size", "1G"]);
});

test("only --id is passed when the cluster is unset", async () => {
    const rbd = createRbd({ pool: "mypool", user: "admin", map_options: [] });

    await rbd.create("volume1", "1G");

    assert.deepStrictEqual(runner.lastCall.args, ["--id", "admin", "create", "--pool", "mypool", "volume1", "--size", "1G"]);
});

test("a failing create turns into an error naming the command", async () => {
    const rbd = createRbd();

    runner.nextFailure(1, "image already exists");

    await assert.rejects(() => rbd.create("volume1", "1G"), {
        message: "rbd create command failed with code 1: image already exists",
    });
});

test("a failing map turns into an error naming the command", async () => {
    const rbd = createRbd();

    runner.nextFailure(2, "no such image");

    await assert.rejects(() => rbd.map("volume1"), {
        message: "rbd map command failed with code 2: no such image",
    });
});

test("a failing unmap turns into an error naming the command", async () => {
    const rbd = createRbd({ pool: "mypool", map_options: [] });

    runner.next({ stdout: showmappedOutput([{ pool: "mypool", name: "volume1", device: "/dev/rbd0" }]) });
    runner.nextFailure(16, "device busy");

    await assert.rejects(() => rbd.unMap("volume1"), {
        message: "rbd unmap command failed with code 16: device busy",
    });
});

test("a failing showmapped turns into an error naming the command", async () => {
    const rbd = createRbd();

    runner.nextFailure(1, "cluster unreachable");

    await assert.rejects(() => rbd.isMapped("volume1"), {
        message: "rbd showmapped command failed with code 1: cluster unreachable",
    });
});

test("a failing list turns into an error naming the command", async () => {
    const rbd = createRbd();

    runner.nextFailure(1, "unreachable");

    await assert.rejects(() => rbd.list(), {
        message: "rbd list command failed with code 1: unreachable",
    });
});

test("a failing remove turns into an error naming the command", async () => {
    const rbd = createRbd();

    runner.nextFailure(2, "not found");

    await assert.rejects(() => rbd.remove("volume1"), {
        message: "rbd remove command failed with code 2: not found",
    });
});

test("a failing makeFilesystem turns into an error naming the command", async () => {
    const rbd = createRbd();

    runner.nextFailure(1, "bad filesystem type");

    await assert.rejects(() => rbd.makeFilesystem("xfs", "/dev/rbd0"), {
        message: "mkfs -t xfs /dev/rbd0 command failed with code 1: bad filesystem type",
    });
});

test("a failing mount turns into an error naming the command", async () => {
    const rbd = createRbd();

    runner.nextFailure(32, "wrong fs type");

    await assert.rejects(() => rbd.mount("/dev/rbd0", "/mnt/volumes/mypool/volume1"), {
        message: "mount command failed with code 32: wrong fs type",
    });
});

test("a failing unmount turns into an error naming the command", async () => {
    const rbd = createRbd();

    runner.nextFailure(32, "not mounted");

    await assert.rejects(() => rbd.unmount("/mnt/volumes/mypool/volume1"), {
        message: "umount command failed with code 32: not mounted",
    });
});

test("a failing unmount does not remove the mount point", async () => {
    const rbd = createRbd();

    runner.nextFailure(32, "not mounted");

    await assert.rejects(() => rbd.unmount("/mnt/volumes/mypool/volume1"));

    assert.deepStrictEqual(fileSystem.calls, []);
});

test("a failing mount removes the mount point it created", async () => {
    const rbd = createRbd({ pool: "mypool", map_options: [] });
    const mountPoint = "/mnt/volumes/mypool/volume1";

    runner.nextFailure(32, "wrong fs type");

    await assert.rejects(() => rbd.mount("/dev/rbd0", mountPoint), {
        message: "mount command failed with code 32: wrong fs type",
    });

    assert.deepStrictEqual(fileSystem.existsCalls, [mountPoint]);
    assert.deepStrictEqual(fileSystem.calls, [
        ["mkdirSync", mountPoint, '{"recursive":true}'],
        ["rmdirSync", mountPoint],
    ]);
    assert.strictEqual(fileSystem.existing.has(mountPoint), false, "the created directory must be gone");
});

test("a failing mount keeps a mount point that already existed", async () => {
    const rbd = createRbd({ pool: "mypool", map_options: [] });
    const mountPoint = "/mnt/volumes/mypool/volume1";
    fileSystem.existing.add(mountPoint);

    runner.nextFailure(32, "wrong fs type");

    await assert.rejects(() => rbd.mount("/dev/rbd0", mountPoint), {
        message: "mount command failed with code 32: wrong fs type",
    });

    assert.deepStrictEqual(fileSystem.calls, [["mkdirSync", mountPoint, '{"recursive":true}']]);
    assert.strictEqual(fileSystem.existing.has(mountPoint), true, "a pre-existing directory must be kept");
});

test("a cleanup failure after a failing mount does not hide the mount error", async () => {
    const rbd = createRbd({ pool: "mypool", map_options: [] });
    const mountPoint = "/mnt/volumes/mypool/volume1";
    fileSystem.failRmdirWith = "directory not empty";

    runner.nextFailure(32, "wrong fs type");

    await assert.rejects(() => rbd.mount("/dev/rbd0", mountPoint), {
        message: "mount command failed with code 32: wrong fs type",
    });

    assert.deepStrictEqual(fileSystem.calls, [
        ["mkdirSync", mountPoint, '{"recursive":true}'],
        ["rmdirSync", mountPoint],
    ]);
});

test("invalid showmapped output turns into an error naming the command", async () => {
    const rbd = createRbd();

    runner.next({ stdout: "not json" });

    await assert.rejects(() => rbd.isMapped("volume1"), (error: Error) => {
        assert.match(error.message, /^rbd showmapped command failed with code undefined: /);
        return true;
    });
});
