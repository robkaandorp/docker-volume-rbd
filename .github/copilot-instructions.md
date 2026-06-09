# Copilot Instructions

## Build

```bash
pnpm install          # install dependencies
pnpm run build        # compile TypeScript → dist/ (runs tsc)
```

There are no tests or linters configured.

## Architecture

This is a **Docker managed plugin** (not a regular container) that exposes the [Docker Volume Plugin API](https://docs.docker.com/engine/extend/plugins_volume/) over a Unix socket at `/run/docker/plugins/rbd.sock`.

### Request flow

1. Docker sends HTTP POST requests to the Unix socket.
2. `src/server.ts` — Express server (Express 5) that handles all Docker Volume Plugin API endpoints (`/VolumeDriver.Create`, `/VolumeDriver.Mount`, `/VolumeDriver.Unmount`, etc.). Holds an in-memory `mountPointTable` (`Map<string, MountPointEntry>`) for reference-counting active mounts.
3. `src/rbd.ts` — `Rbd` class wraps Ceph CLI tools (`rbd`, `mount`, `umount`, `mkfs`) via `child_process.execFile`. All operations are async/await.
4. `src/mountPointEntry.ts` — Tracks a mount point and the container IDs (`references[]`) currently using it. The volume is only physically unmounted when the last reference is removed.

### Mount point paths

Volumes are mounted at `/mnt/volumes/{pool}/{name}` inside the plugin container. This path is declared as `propagatedmount` in `config.json` so Docker can see it.

### Docker plugin packaging

`config.json` is the Docker plugin manifest (not app config). It declares required Linux capabilities (`CAP_SYS_ADMIN`, `CAP_SYS_MODULE`, `CAP_NET_ADMIN`), bind mounts (`/dev`, `/etc/ceph`, `/sys`, `/lib/modules`), and the settable env vars.

The Dockerfile is a multi-stage build:
- `base` — Ubuntu + Node.js LTS + `ceph-common` + `xfsprogs`
- `builder` — installs pnpm deps and compiles TypeScript
- final stage — copies built app and sets `entrypoint.sh` as CMD

## Key Conventions

### API response shape
Every Docker Volume Plugin endpoint **must** return an `Err` field — empty string on success, error message on failure. Errors are never thrown to Express; they are caught and returned as `{ Err: (error as Error).message }`.

### `rbd remove` uses trash
`Rbd.remove()` uses `rbd trash move` (not `rbd rm`), so removed images go to the Ceph trash rather than being permanently deleted immediately.

### `RBD_CONF_MAP_OPTIONS` separator
Multiple `rbd map` options are passed as a **semicolon-separated** string (e.g., `--exclusive;--read-only`), split in `server.ts` before being spread into the CLI args array.

### execFile timeouts
All `execFile` calls use a 30 000 ms timeout except `mkfs`, which uses 120 000 ms.

### Unimplemented options
`RBD_CONF_CLUSTER` and `RBD_CONF_KEYRING_USER` are read from the environment and stored in `Rbd.options` but are not yet passed to CLI commands (marked `// ToDo` in the source).

### TypeScript config
- Compiled with TypeScript 6
- Target: `es6`, module system: `commonjs`
- `noImplicitAny: true`
- Output: `dist/` (committed to the image but not to git)
