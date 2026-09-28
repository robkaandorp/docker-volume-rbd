import test from "node:test";
import assert from "node:assert";

import { parseConfig } from "./config";

test("pool defaults to rbd when unset", () => {
    assert.strictEqual(parseConfig({}).pool, "rbd");
});

test("pool defaults to rbd when empty", () => {
    assert.strictEqual(parseConfig({ RBD_CONF_POOL: "" }).pool, "rbd");
});

test("pool is taken from RBD_CONF_POOL when set", () => {
    assert.strictEqual(parseConfig({ RBD_CONF_POOL: "mypool" }).pool, "mypool");
});

test("cluster and user are undefined when unset", () => {
    const config = parseConfig({});

    assert.strictEqual(config.cluster, undefined);
    assert.strictEqual(config.user, undefined);
});

test("cluster and user are undefined when empty", () => {
    const config = parseConfig({ RBD_CONF_CLUSTER: "", RBD_CONF_KEYRING_USER: "" });

    assert.strictEqual(config.cluster, undefined);
    assert.strictEqual(config.user, undefined);
});

test("cluster and user are taken from the environment when set", () => {
    const config = parseConfig({ RBD_CONF_CLUSTER: "ceph2", RBD_CONF_KEYRING_USER: "admin" });

    assert.strictEqual(config.cluster, "ceph2");
    assert.strictEqual(config.user, "admin");
});

test("map options default to --exclusive when unset", () => {
    assert.deepStrictEqual(parseConfig({}).map_options, ["--exclusive"]);
});

test("map options are empty when explicitly set to an empty string", () => {
    assert.deepStrictEqual(parseConfig({ RBD_CONF_MAP_OPTIONS: "" }).map_options, []);
});

test("map options are split on semicolons", () => {
    assert.deepStrictEqual(
        parseConfig({ RBD_CONF_MAP_OPTIONS: "--exclusive;--read-only" }).map_options,
        ["--exclusive", "--read-only"]);
});

test("empty segments in map options are dropped", () => {
    assert.deepStrictEqual(
        parseConfig({ RBD_CONF_MAP_OPTIONS: ";;--exclusive;;;--read-only;;" }).map_options,
        ["--exclusive", "--read-only"]);
});

test("map options consisting only of separators yields an empty array", () => {
    assert.deepStrictEqual(parseConfig({ RBD_CONF_MAP_OPTIONS: ";;" }).map_options, []);
});

test("parseConfig returns the full configuration", () => {
    assert.deepStrictEqual(
        parseConfig({
            RBD_CONF_POOL: "mypool",
            RBD_CONF_CLUSTER: "ceph2",
            RBD_CONF_KEYRING_USER: "admin",
            RBD_CONF_MAP_OPTIONS: "--exclusive;--read-only",
        }),
        {
            pool: "mypool",
            cluster: "ceph2",
            user: "admin",
            map_options: ["--exclusive", "--read-only"],
        });
});

test("parseConfig does not read from the real process environment", () => {
    // A pure function: only the object it is given matters.
    const config = parseConfig({ RBD_CONF_POOL: "fromargument" });

    assert.strictEqual(config.pool, "fromargument");
});
