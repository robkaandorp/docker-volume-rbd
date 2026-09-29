# Copilot Instructions

## Setup, build, and tests

Node.js major version is pinned in `.node-version` (currently 24); the Dockerfile derives the NodeSource setup URL from that value, and `@types/node` uses the matching major. If `node` is missing or has the wrong major, use the `setup-node` skill; from the repository root:

```bash
export PATH="$(.github/skills/setup-node/install-node.sh):$PATH"
```

Corepack uses `package.json`'s `packageManager` field to select pnpm. To bump the Node LTS, update `.node-version` and the `@types/node` major together, then regenerate `pnpm-lock.yaml` with pnpm—never edit the lockfile by hand.

```bash
pnpm install
pnpm run build
pnpm test
```

Tests use Node's built-in `node:test`, live in `src/*.test.ts`, and compile to `dist/`. Tests exist; there is no linter.

## Architecture

This is a Docker managed plugin exposing the Docker Volume Plugin API over `/run/docker/plugins/rbd.sock`. The request flow is `server.ts` (`parseConfig` → `Rbd` → `createApp` → listen on the socket). In `src/`:

- `config.ts` parses environment settings with `parseConfig`.
- `app.ts` defines `createApp`, `RbdInterface`, the route handlers, per-app in-memory mount table, per-volume `createVolumeLock`/`withVolumeLock`, and best-effort rollback through `cleanupBestEffort`.
- `rbd.ts` implements `Rbd`, with injectable `CommandRunner` and `FileSystem`; `getMountedDevice` reads `/proc/mounts`.
- `mountPointEntry.ts` tracks mount references. Mount paths are `/mnt/volumes/{pool}/{name}`.

The lock serializes same-volume work only within this process. The mount table is in memory and deliberately has no startup recovery. Tracked volumes use the normal reference-counting path: tracked Mount adds the caller ID, and tracked Unmount removes it and cleans up on the last reference; neither checks `/proc/mounts`.

For a volume with **no mount-table entry** (for example, after a plugin restart), Mount and Unmount inspect the mapped device and the device mounted at the mountpoint. A mounted device that is not the image's mapped device—or any mounted device when the image is unmapped—returns an `Err` without changing anything. An untracked Mount adopts an existing mount when it is the image's own mapped device. Untracked Unmount is explicit cleanup, not rollback: if that device is mounted at the mountpoint it unmounts it, then unmaps the image if mapped. It returns an empty `Err` when cleanup succeeds, including when there is nothing to do; a failed step stops remaining cleanup and its error is returned. This can clean up a volume still used by a pre-restart container; that is an accepted trade-off because references do not survive a restart.

Mount/Create rollback is best-effort: cleanup failures are logged and do not replace the original error. Rollback only undoes work owned by that request. In particular, Create keeps a formatted image if its final unmap fails rather than removing it.

## Configuration and API conventions

- `RBD_CONF_POOL` selects the pool (default `rbd`). `RBD_CONF_CLUSTER` and `RBD_CONF_KEYRING_USER` are passed to rbd commands as `--cluster` and `--id` only when set, preserving the unset/default behavior.
- `RBD_CONF_MAP_OPTIONS` is semicolon-separated; it defaults to `--exclusive`, and an explicitly empty value disables map options.
- `/VolumeDriver.*` handlers return an `Err` field (empty string on success); `/Plugin.Activate` returns `Implements` without `Err`, and `/VolumeDriver.Capabilities` returns `Capabilities` without `Err`.
- `Rbd.remove()` uses `rbd trash move`, not `rbd rm`.
- `execFile` command timeouts are 30,000 ms, except `mkfs` at 120,000 ms.

App tests use a stub `RbdInterface`; Rbd tests inject fake `CommandRunner` and `FileSystem` implementations. HTTP tests start `app.listen(0)` and use global `fetch`. Tests should not require Ceph, root, or real command binaries.

## TypeScript and Docker packaging

`tsconfig.json` enables `strict`, uses `nodenext` for module and module resolution, targets `esnext`, and includes `es2023` with Node types. The Dockerfile's base stage installs `ceph-common` from the official Ceph Tentacle 20.2 apt repository, Node.js from the pinned major, `xfsprogs`, and `kmod`. The builder installs dependencies, builds, tests, and prunes production dependencies. `.dockerignore` excludes `.git/`. `config.json` is the Docker plugin manifest. The image is packaged and published as a managed plugin with `docker plugin create` and `docker plugin push`.

## Versioning and CI

`develop` is the development branch; releases are merged from `develop` to `master`. `VERSION` uses `v<ceph>-r<revision>`; bump the revision on `develop` before the release merge. `build.sh` derives the base tag from `VERSION`.

In `.github/workflows/docker-image.yml`, the read-only `build` job runs for pushes and pull requests targeting `master` or `develop` (the only trigger branches), builds and tests through the Dockerfile, and packages a `.tgz` artifact. The `publish` job runs only on pushes to `master`; it is serialized with a concurrency group, has the workflow's only `contents: write` permission, and fails closed if the release or tag already exists. It pushes the plugin once as `robkaandorp/rbd:<full>` with `docker plugin push` and then retags `robkaandorp/rbd:<base>` on the registry side by copying that manifest (no second `docker plugin create`), then creates the GitHub release last with `--target` set to the built commit. CopilotHive/agents must not create release tags themselves.
