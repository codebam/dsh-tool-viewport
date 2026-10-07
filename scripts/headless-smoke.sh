#!/usr/bin/env bash
# Start a throwaway headless Viewport and drive the real plugin modules
# against it end to end (scripts/smoke-e2e.mjs). Never touches the live
# session: the instance's control socket and Wayland socket both live under
# a private XDG_RUNTIME_DIR in /tmp.
#
# Environment (all optional):
#   VP_DIR   the Viewport checkout        (default: ~/Documents/git/Viewport)
#   VP_BIN   the binary to run            (default: $VP_DIR/target/debug/viewport)
#   VP_RT    the instance's runtime dir   (default: /tmp/vp-smoke)
#   VP_GRIM  the capture client           (default: grim on PATH)
#   VP_MESA  a mesa with surfaceless EGL  (default: nixpkgs#mesa)
#
# The compositor needs the checkout's devshell for its libraries, and a mesa
# that provides EGL_MESA_platform_surfaceless plus a software renderer for
# headless captures — without that the instance logs "no headless renderer"
# and screenshots fail.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
vp_dir="${VP_DIR:-$HOME/Documents/git/Viewport}"
bin="${VP_BIN:-$vp_dir/target/debug/viewport}"
rt="${VP_RT:-/tmp/vp-smoke}"
grim="${VP_GRIM:-$(command -v grim || true)}"

case "$rt" in
  /run/user/*) echo "refusing VP_RT=$rt: that is a live session's runtime dir" >&2; exit 1 ;;
esac

[ -x "$bin" ] || { echo "no viewport binary at $bin — build it first:" >&2; echo "  (cd $vp_dir && nix develop .#rust -c cargo build -p viewport)" >&2; exit 1; }
[ -n "$grim" ] || { echo "grim not found — put it on PATH or set VP_GRIM" >&2; exit 1; }

mesa="${VP_MESA:-$(nix develop "$vp_dir#rust" -c printenv LD_LIBRARY_PATH 2>/dev/null | tr ':' '\n' | grep -E 'mesa-[0-9.]+/lib$' | head -1 || true)}"
mesa="${mesa%/lib}"
[ -n "$mesa" ] && [ -e "$mesa/share/glvnd/egl_vendor.d" ] || { echo "no mesa with EGL vendor files found (set VP_MESA)" >&2; exit 1; }

rm -rf "$rt"
mkdir -p "$rt"
chmod 700 "$rt"
printf '{ "layout": "tiling" }\n' > "$rt/config.json"

cleanup() { [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null || true; }
trap cleanup EXIT

echo "starting $bin --headless (runtime dir $rt)"
nix develop "$vp_dir#rust" -c bash -c "
  export __EGL_VENDOR_LIBRARY_FILENAMES='$mesa/share/glvnd/egl_vendor.d/50_mesa.json'
  export LIBGL_ALWAYS_SOFTWARE=1
  env -u WAYLAND_DISPLAY -u DISPLAY XDG_RUNTIME_DIR='$rt' VIEWPORT_RENDERER=gles \
    '$bin' --headless -c '$rt/config.json' > '$rt/log' 2>&1 &
  echo \$! > '$rt/pid'
"
pid="$(cat "$rt/pid")"

for _ in $(seq 1 40); do
  [ -S "$rt/viewport-wayland-1.sock" ] && break
  sleep 0.5
done
[ -S "$rt/viewport-wayland-1.sock" ] || { echo "the instance never made its control socket; log:" >&2; tail -20 "$rt/log" >&2; exit 1; }
grep -q "no headless renderer" "$rt/log" && { echo "the instance has no renderer; captures will fail (mesa/EGL problem)" >&2; exit 1; }

VP_EXE="$bin" VP_GRIM="$grim" VP_RT="$rt" node "$here/scripts/smoke-e2e.mjs"
