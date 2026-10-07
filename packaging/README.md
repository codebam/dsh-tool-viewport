# Packaging

Two ways to mount `@codebam/dsh-tool-viewport`, depending on how permanent
it should be.

## While developing: a `--patch` overlay

Nothing is installed; the overlay names this checkout's `index.mjs`.

```sh
node scripts/link-dsh-peers.mjs        # once: links node_modules/@deepseek-ai to the installed dsh
dsh tui --patch ./examples/mount.yml   # one boot; or copy the rows into ~/.dsh/cordis.patch.yml
```

The peers link matters: dsh loads the plugin from this directory, and Node
resolves `@deepseek-ai/dsh-tools` and friends from the plugin's own
`node_modules`, which the script points at the installed dsh closure.

## Durable: NixOS, the way `dsh-tool-nu` is

Three files, mirroring that plugin's packaging:

- `nixos/dsh-tool-viewport.nix` — the derivation. **Its `hash` is a
  placeholder**: it pins a `v0.1.0` tag that does not exist yet. Push the
  tag, compute the unpacked-tree hash
  (`nix-prefetch-url --unpack <tag tarball>`, converted to SRI), and fill
  it in.
- `nixos/default.nix.snippet` — the `pkgs` entry (`callPackage`).
- `nixos/agents.nix.snippet` — the home-manager pieces: Part A copies the
  plugin into `$DSH_HOME/profiles/viewport-tool/` next to the shared
  `node_modules` symlink; Part B appends the profile patch row that mounts
  it, with `executable` pointing at the session's own binary.

Both existing `dsh-tool-nu` blocks are the models to copy — same layout,
same copy-into-$DSH_HOME reasoning, same row shape.

## Two things the config must get right

- **`executable`**: the control socket only accepts synthetic input from
  the executable the session itself runs (`docs/ipc.md` § Control-socket
  trust in the Viewport repository). `/run/current-system/sw/bin/viewport`
  is that binary while the session is current; after a rebuild, restart
  the session or the tool's messages are refused as an untrusted client.
- **`grim`**: needs `zwlr-screencopy-v1` (Viewport has it) and the
  session's Wayland socket. Inside the session the default `grim` on PATH
  is fine; from outside, set `runtimeDir` and `waylandDisplay`.
