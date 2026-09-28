#!/usr/bin/env bash
set -euo pipefail

log() { echo "setup-node: $*" >&2; }
fail() { log "error: $*"; exit 1; }

repo_root="$(git rev-parse --show-toplevel)"
version_file="$repo_root/.node-version"
[[ -f "$version_file" ]] || fail "$version_file not found"
raw="$(< "$version_file")"
major="${raw#"${raw%%[![:space:]]*}"}"
major="${major%"${major##*[![:space:]]}"}"
[[ "$major" =~ ^[0-9]+$ ]] || fail "$version_file must contain a plain integer major version, got '$raw'"

node_major() {
  local version
  version="$("$1" --version 2>/dev/null)" || return 0
  version="${version#v}"
  echo "${version%%.*}"
}

if command -v node >/dev/null 2>&1 && [[ "$(node_major node)" == "$major" ]]; then
  dirname "$(command -v node)"
  exit 0
fi

install_dir="${NODE_INSTALL_DIR:-/tmp/node-v$major}"

if [[ -x "$install_dir/bin/node" && "$(node_major "$install_dir/bin/node")" == "$major" ]]; then
  log "reusing Node.js $("$install_dir/bin/node" --version) in $install_dir"
else
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) fail "unsupported architecture: $(uname -m)" ;;
  esac

  base_url="https://nodejs.org/dist/latest-v$major.x"
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT

  log "fetching $base_url/SHASUMS256.txt"
  curl -fsSL "$base_url/SHASUMS256.txt" -o "$tmp_dir/SHASUMS256.txt"
  tarball="$(awk '{ print $2 }' "$tmp_dir/SHASUMS256.txt" | grep -xE "node-v[0-9.]+-linux-$arch\.tar\.gz" || true)"
  [[ -n "$tarball" ]] || fail "no linux-$arch .tar.gz found in $base_url/SHASUMS256.txt"

  log "downloading $base_url/$tarball"
  curl -fsSL "$base_url/$tarball" -o "$tmp_dir/$tarball"
  (cd "$tmp_dir" && grep "  $tarball\$" SHASUMS256.txt | sha256sum -c - >&2)

  mkdir -p "$install_dir"
  tar -xzf "$tmp_dir/$tarball" --strip-components=1 -C "$install_dir"
  log "installed Node.js $("$install_dir/bin/node" --version) in $install_dir"
fi

if [[ -x "$install_dir/bin/corepack" ]]; then
  PATH="$install_dir/bin:$PATH" corepack enable --install-directory "$install_dir/bin" pnpm >&2
else
  log "warning: corepack not found; run 'npm install -g corepack' first to get the pnpm version pinned in package.json"
fi

echo "$install_dir/bin"
