---
name: setup-node
description: Install the project's pinned Node.js LTS (major version in .node-version) and pnpm when `node` is missing or the wrong major. Use before running pnpm install, pnpm run build or pnpm test.
---

# Setup Node

## When to use

Use this skill when `node --version` fails, or reports a major version different from the one in `.node-version`.

## Usage

From the repository root:

```bash
export PATH="$(.github/skills/setup-node/install-node.sh):$PATH"
```

The script prints only the Node `bin` directory on stdout (all progress goes to stderr). It downloads the latest release of the pinned major from nodejs.org, verifies its SHA-256 checksum, installs it into `${NODE_INSTALL_DIR:-/tmp/node-v<major>}`, and enables Corepack so `pnpm` resolves to the version pinned in `package.json` (`packageManager`).

PATH changes do not persist across separate shell/tool invocations. Re-run the export line in every new shell (it is idempotent and fast after the first install), or chain commands:

```bash
export PATH="$(.github/skills/setup-node/install-node.sh):$PATH" && pnpm install --frozen-lockfile && pnpm run build
```

## Rules

- Never commit the Node installation or anything under the install directory.
- Never change `.node-version`, `packageManager` or the Dockerfile Node setup as part of unrelated work.
- Bumping to a new LTS major means changing `.node-version` and the `@types/node` major together, regenerating `pnpm-lock.yaml` with pnpm, and rebuilding the image.
