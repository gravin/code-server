#!/usr/bin/env bash
# Windows entry point: build-and-start.bat. All builds use these local forks.
main() {
set -Eeuo pipefail
source_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
target='/mnt/d/BaiduNetdiskDownload/智能体集/claude_code'
mode=run
for arg in "$@"; do
  case "$arg" in
    --check) mode=check ;;
    --build-only) mode=build ;;
    --help) echo 'build-and-start.bat [Windows project path] [--check | --build-only]'; exit 0 ;;
    --*) echo "Unknown option: $arg" >&2; exit 1 ;;
    *) target=$(wslpath -u "$arg") ;;
  esac
done
[[ -d "$target" ]] || { echo "Project directory does not exist: $target" >&2; exit 1; }
port=${ELEVATOR_PREVIEW_PORT:-8080}
[[ "$port" =~ ^[0-9]+$ ]] && ((port > 0 && port < 65536)) || { echo 'Invalid preview port' >&2; exit 1; }
tour_source=''
while IFS= read -r -d '' candidate; do
  if [[ "${candidate##*/}" == [Cc][Oo][Dd][Ee][Tt][Oo][Uu][Rr] && -f "$candidate/package.json" ]]; then
    [[ -z "$tour_source" ]] || { echo 'Multiple sibling CodeTour folders found' >&2; exit 1; }
    tour_source=$candidate
  fi
done < <(find "$(dirname "$source_root")" -mindepth 1 -maxdepth 1 -type d -print0)
echo "code-server source: $source_root"
echo "CodeTour source: ${tour_source:-absent (extension build skipped)}"
echo "Reading workspace: $target"
if [[ "$mode" == check ]]; then
  command -v git rsync curl python3 flock >/dev/null
  echo 'WSL and source paths checked. --check does not install or build.'
  exit 0
fi
cache_id=$(printf '%s' "$source_root" | sha256sum | cut -c1-16)
cache="$HOME/.cache/elevator-preview/$cache_id"
mkdir -p "$cache"
exec 9>"$cache/build.lock"
flock -n 9 || { echo 'This preview is already building/running. Close its window first.' >&2; exit 1; }
exec > >(tee -a "$cache/build.log") 2>&1
trap 'echo "FAILED at line $LINENO. Log: $cache/build.log" >&2' ERR
echo "Build cache and logs: $cache"

# Install Linux build tools only if missing. sudo may ask for the Ubuntu password.
packages=(build-essential git git-lfs curl ca-certificates rsync jq quilt unzip pkg-config python-is-python3 libx11-dev libxkbfile-dev libsecret-1-dev libkrb5-dev)
missing=()
for package in "${packages[@]}"; do
  dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed' || missing+=("$package")
done
if ((${#missing[@]})); then
  export http_proxy=${http_proxy:-${HTTP_PROXY:-}}
  export https_proxy=${https_proxy:-${HTTPS_PROXY:-}}
  apt_options=(-o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o Acquire::Retries=1)
  # Use HTTPS for Ubuntu's official repositories without editing system sources.
  if [[ -f /etc/apt/sources.list.d/ubuntu.sources ]]; then
    sed 's|http://|https://|g' /etc/apt/sources.list.d/ubuntu.sources > "$cache/ubuntu.sources"
    apt_options+=(-o "Dir::Etc::sourcelist=$cache/ubuntu.sources" -o 'Dir::Etc::sourceparts=-')
  fi
  sudo --preserve-env=http_proxy,https_proxy apt-get "${apt_options[@]}" update
  sudo --preserve-env=http_proxy,https_proxy apt-get "${apt_options[@]}" install -y "${missing[@]}"
fi
# Use a private Node 24 runtime; never replace the system Node installation.
runtime="$cache/runtime"
if [[ ! -x "$runtime/bin/node" ]]; then
  mkdir -p "$runtime"
  case $(uname -m) in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) echo 'Unsupported CPU'; exit 1 ;; esac
  curl -fsSL --retry 3 https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$cache/node-checksums.txt"
  archive=$(awk -v arch="$arch" '$2 ~ ("linux-" arch "\\.tar\\.xz$") {print $2}' "$cache/node-checksums.txt")
  [[ -n "$archive" && "$archive" != *$'\n'* ]]
  curl -fSL --retry 3 "https://nodejs.org/dist/latest-v24.x/$archive" -o "$cache/$archive"
  (cd "$cache"; grep "  $archive$" node-checksums.txt | sha256sum -c -)
  tar -xJf "$cache/$archive" --strip-components=1 -C "$runtime"
fi
export PATH="$runtime/bin:$PATH"
export NODE_OPTIONS="--max-old-space-size=4096 --use-env-proxy"
export MINIFY='' VERSION=0.0.0 KEEP_MODULES=1
echo "Node $(node --version), npm $(npm --version)"
build_root="$cache/code-server"
mkdir -p "$build_root"
# Recover our temporary build-task adaptation if a previous WSL process died.
core_file="$build_root/lib/vscode/build/gulpfile.vscode.ts"
if [[ -f "$cache/core-ci-original.ts" && -f "$core_file" ]] && grep -q 'elevator-preview: browser server only' "$core_file"; then
  cp "$cache/core-ci-original.ts" "$core_file"
fi
# Pop using the OLD patch files before syncing an edited Windows patch stack.
if [[ -s "$build_root/.pc/applied-patches" ]]; then
  (cd "$build_root"; quilt pop -a)
fi
# --delete only touches our generated Linux cache, never either source fork.
# Keep dependency/output directories and the independently checked-out submodule.
rsync -a --delete --exclude='/.git/modules/' --exclude='/lib/vscode/' \
  --exclude='/node_modules/' --exclude='/test/node_modules/' --exclude='/test/e2e/extensions/test-extension/node_modules/' \
  --exclude='/out/' --exclude='/release/' --exclude='/lib/vscode-reh-web-*/' \
  --exclude='/.pc/' --exclude='/.cache/' "$source_root/" "$build_root/"
cd "$build_root"
git config core.autocrlf false
# Windows Git may have checked out scripts and patches with CRLF. Normalize
# tracked text only in the generated Linux build copy (source files stay intact).
python3 - <<'PY'
import pathlib, subprocess
for name in subprocess.check_output(['git', 'ls-files', '-z']).split(b'\0'):
    if not name:
        continue
    p = pathlib.Path(name.decode())
    if p.is_file():
        data = p.read_bytes()
        if b'\0' not in data and b'\r\n' in data:
            p.write_bytes(data.replace(b'\r\n', b'\n'))
PY

# Restore this fork's patch stack, including edits made since the previous run.
patch_key=$({ git ls-tree HEAD lib/vscode; find patches -type f -print0 | sort -z | xargs -0 sha256sum; } | sha256sum | cut -d' ' -f1)
if [[ ! -f "$cache/patch-key" || $(cat "$cache/patch-key") != "$patch_key" || ! -s .pc/applied-patches ]]; then
  git submodule update --init --depth 1 lib/vscode
  quilt push -a
  printf '%s' "$patch_key" > "$cache/patch-key"
fi
# VS Code changes follow this fork's quilt patch stack, as in CONTRIBUTING.md.
# Do not overwrite the patched cache with an unpatched Windows submodule.
source_digest() {
  python3 - "$1" <<'PY'
import hashlib, pathlib, subprocess, sys
root = pathlib.Path(sys.argv[1])
names = subprocess.check_output(['git', '-C', str(root), 'ls-files', '-z', '--cached', '--others', '--exclude-standard']).split(b'\0')
h = hashlib.sha256()
for name in sorted(set(names)):
    if not name or name == b'product.json' or name.endswith((b'product.original.json', b'npm-shrinkwrap.json')):
        continue
    p = root / name.decode()
    if p.is_file():
        data = p.read_bytes()
        if b'\0' not in data:
            data = data.replace(b'\r\n', b'\n')
        h.update(name + b'\0' + data)
print(h.hexdigest())
PY
}
install_if_changed() {
  local directory=$1 stamp=$2 key
  key=$(sha256sum "$directory/package.json" "$directory/package-lock.json" | sha256sum | cut -d' ' -f1)
  if [[ ! -d "$directory/node_modules" || ! -f "$stamp" || $(cat "$stamp") != "$key" ]]; then
    (cd "$directory"; npm ci)
    printf '%s' "$key" > "$stamp"
  fi
}
SKIP_SUBMODULE_DEPS=1 install_if_changed "$build_root" "$cache/server-deps-key"
install_if_changed "$build_root/lib/vscode" "$cache/vscode-deps-key"
npm run build
# Include source edits as well as patches in the VS Code build fingerprint.
vscode_source_key=$(source_digest "$build_root/lib/vscode")
vscode_key=$(printf '%s:%s' "$patch_key" "$vscode_source_key" | sha256sum | cut -d' ' -f1)
if [[ ! -f "$cache/vscode-build-key" || $(cat "$cache/vscode-build-key") != "$vscode_key" || ! -f lib/vscode-reh-web-linux-$(node -p process.arch)/out/server-main.js ]]; then
  # The current VS Code core-ci task builds desktop and two server variants in
  # parallel. For local preview build only the non-minified browser server.
  # Adapt build orchestration in the generated cache, then restore it even on
  # failure. Application source and the Windows forks are untouched.
  cp "$core_file" "$cache/core-ci-original.ts"
  cp ci/build/build-vscode.sh "$cache/build-vscode-original.sh"
  (
    trap 'cp "$cache/core-ci-original.ts" "$core_file"; cp "$cache/build-vscode-original.sh" "$build_root/ci/build/build-vscode.sh"' EXIT
    python3 - "$core_file" <<'PY'
import pathlib, re, sys
p = pathlib.Path(sys.argv[1])
source = p.read_text()
pattern = r"\ttask\.parallel\(\n(?:\t\ttask\.define\('esbuild-vscode(?:-reh(?:-web)?)?-min'.*\n){3}\t\)"
replacement = "\t// elevator-preview: browser server only\n\ttask.define('esbuild-vscode-reh-web', () => runEsbuildBundle('out-vscode-reh-web', false, true, 'server-web'))"
updated, count = re.subn(pattern, replacement, source)
if count != 1:
    raise SystemExit('VS Code core-ci layout changed; update the browser-only build adapter before building.')
p.write_text(updated)
PY
    python3 - "$build_root/ci/build/build-vscode.sh" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
source = p.read_text()
if source.count('npm run gulp') != 3:
    raise SystemExit('code-server build:vscode layout changed; update the local build adapter.')
source = source.replace('npm run gulp', 'node --experimental-strip-types --max-old-space-size=4096 ./node_modules/gulp/bin/gulp.js')
p.write_text(source)
PY
    npm run build:vscode
  )
  printf '%s' "$vscode_key" > "$cache/vscode-build-key"
else
  echo 'VS Code sources unchanged; reusing the locally compiled VS Code build.'
fi
npm run release
server="$build_root/release/bin/code-server"
state="$cache/preview"
mkdir -p "$state/user-data/User" "$state/extensions"
# Seed new profiles with the preview defaults. Keep existing user settings.
if [[ ! -f "$state/user-data/User/settings.json" ]]; then
  cp "$build_root/ci/dev/preview-settings.json" "$state/user-data/User/settings.json"
fi
common=(--user-data-dir "$state/user-data" --extensions-dir "$state/extensions")
if [[ -n "$tour_source" ]]; then
  tour_build="$cache/codetour"
  mkdir -p "$tour_build"
  rsync -a --delete --exclude='.git' --exclude='node_modules' --exclude='dist' --exclude='*.vsix' "$tour_source/" "$tour_build/"
  install_if_changed "$tour_build" "$cache/tour-deps-key"
  (cd "$tour_build"; npm run build; ./node_modules/.bin/vsce package --no-dependencies --no-update-package-json --out "$cache/codetour-local.vsix")
  "$server" "${common[@]}" --install-extension "$cache/codetour-local.vsix" --force
  # Copy the reviewable VSIX back to the fork; it is already gitignored.
  cp "$cache/codetour-local.vsix" "$tour_source/codetour-local.vsix"
fi
"$server" "${common[@]}" --version
"$server" "${common[@]}" --list-extensions
if [[ "$mode" == build ]]; then echo 'Build and extension installation completed.'; exit 0; fi
if python3 - "$port" <<'PY'
import socket, sys
with socket.socket() as s:
    s.settimeout(0.5)
    try:
        occupied = s.connect_ex(('127.0.0.1', int(sys.argv[1]))) == 0
    except (TimeoutError, OSError):
        occupied = False
    sys.exit(0 if occupied else 1)
PY
then
  echo "Port $port is already occupied. Close the previous server or set ELEVATOR_PREVIEW_PORT." >&2
  exit 1
fi
url="http://127.0.0.1:$port/"
echo "Starting $url (Ctrl+C to stop)."
"$server" "${common[@]}" --bind-addr "127.0.0.1:$port" --auth none --disable-telemetry "$target" &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true' EXIT
trap 'exit 130' INT TERM
ready=0
for ((attempt=0; attempt<120; attempt++)); do
  # Test from Windows, where the user's browser runs. Some WSL network modes
  # expose localhost correctly to Windows while Linux loopback probes time out.
  if command -v powershell.exe >/dev/null; then
    if powershell.exe -NoProfile -Command "try { \$request=[System.Net.WebRequest]::Create('${url}healthz'); \$request.Proxy=\$null; \$request.Timeout=2000; \$response=\$request.GetResponse(); \$response.Close(); exit 0 } catch { exit 1 }"; then
      ready=1; break
    fi
  elif curl --noproxy '*' --connect-timeout 1 --max-time 2 -fsS "${url}healthz" >/dev/null; then
    ready=1; break
  fi
  kill -0 "$server_pid" 2>/dev/null || { wait "$server_pid"; exit 1; }
  sleep 1
done
((ready)) || { echo 'Server startup timed out'; exit 1; }
if [[ -z ${ELEVATOR_NO_BROWSER:-} ]]; then
  powershell.exe -NoProfile -Command "Start-Process '$url'" || echo "Open $url in your browser."
fi
wait "$server_pid"
}

main "$@"
