# dsh-tool-viewport

A model-facing [DeepSeek Harness](https://github.com/deepseek-ai) tool for the
[Viewport](https://github.com/codebam/Viewport) Wayland compositor: see the
desktop and drive it — screenshots, pointer moves, clicks, wheel scrolls,
typing and key chords — over the compositor's control socket.

One tool, `viewport`, one action per call, all through the trusted
`viewport msg` client the compositor itself ships. Mounted beside
`@codebam/dsh-tool-nu`.

## What the model gets

| action | what it does |
| --- | --- |
| `screenshot` | Captures the whole desktop. The image comes back as an attachment when the composition mounts an `attachments` service; the text result always names the capture's path, pixel size and byte size. |
| `move` | Puts the pointer at `(x, y)` — layout pixels, the same pixels as the screenshot, `(0, 0)` at its top-left. |
| `click` | Presses and releases a mouse button (`button`: `left`, `right`, `middle` — left by default) at the pointer, or moves to `(x, y)` and clicks there in one call. |
| `scroll` | Turns the wheel by `(dx, dy)` notches — positive up, positive right. Moves to `(x, y)` first when given. |
| `type` | Types text: `\n` is Return, `\t` is Tab. Up to 2000 characters per call. |
| `key` | Presses one named key (`Return`, `Escape`, `Tab`, arrows, `F5`, …), a single character, or a `+` chord (`ctrl+c`, `ctrl+shift+t`). |

The tool's description tells the model the same thing the rest of this
document tells you: this drives the session a person is sitting at, so
`screenshot` first, act on what the image shows, screenshot again to check.

## Requirements

- A running Viewport session.
- The `viewport` client **the session itself runs** — the control socket
  only accepts synthetic input from the session's own executable (see
  `docs/ipc.md` § Control-socket trust in the Viewport repository), so
  `executable` must resolve to that same build, e.g.
  `/run/current-system/sw/bin/viewport`.
- `grim` on PATH (or pinned in config) for captures — Viewport speaks
  `zwlr-screencopy-v1`.
- A dsh with `@deepseek-ai/dsh-tools` 0.2.x (`defineTool`, the
  `attachments` service); developed and tested against dsh 0.2.1-alpha.1.

Scroll support needs a Viewport built with `input.scroll` (the same
repository's `input.scroll` addition completes the synthetic-input family).
`move`, `click`, `type` and `key` need only the existing `input.pointer`,
`input.button` and `osk.key` messages.

## Configuration

The tool reads one config object (all optional):

| key | default | what it does |
| --- | --- | --- |
| `executable` | `viewport` | The client to run. Point it at the same binary the session runs. |
| `grim` | `grim` | The capture client. |
| `socket` | — | The control socket to talk to. Left out, the client finds the session from its own environment (`VIEWPORT_SOCKET`, then `XDG_RUNTIME_DIR`). |
| `runtimeDir` | — | `XDG_RUNTIME_DIR` override, for a harness outside the session. |
| `waylandDisplay` | — | The Wayland display to talk to, e.g. `wayland-1`, for a harness outside the session (grim and the client both need it). |
| `screenshotDir` | temp dir | Where captures are written; the model sees the path in every screenshot result. |
| `timeoutMs` | `10000` | Per-message budget; a batch scales it by message count, capped at five minutes. |

## Mounting it

### Quick, from this checkout — a `--patch` overlay

```sh
node scripts/link-dsh-peers.mjs        # once: links node_modules/@deepseek-ai to the installed dsh
dsh tui --patch ./examples/mount.yml   # or put the same rows in ~/.dsh/cordis.patch.yml
```

`examples/mount.yml` is the overlay: an `insert` row naming this checkout's
`index.mjs` plus a config block. Its comments show both the
defaults-are-right case (a dsh running inside the session) and the pinned
case used for testing against a throwaway instance.

### Durable — NixOS, the way `dsh-tool-nu` is packaged

`packaging/nixos/` carries the three pieces, mirroring that plugin:
`dsh-tool-viewport.nix` (the derivation; the hash is a placeholder until a
`v0.1.0` tag is pushed), `default.nix.snippet` (the `pkgs` entry) and
`agents.nix.snippet` (the home-manager copy into
`$DSH_HOME/profiles/viewport-tool/` next to the shared `node_modules`
symlink, plus the profile patch row). See `packaging/README.md`.

## How it talks to Viewport

The control socket refuses synthetic input from anyone but the session's
own binary, so every action is one or more `viewport msg` invocations —
the trusted client — never a hand-rolled socket writer. Several messages
in one action (a click's press and release, a chord's modifiers, a typed
string) run as one `sh` script of sequential invocations, each waiting for
the acceptance barrier before the next; a refusal stops the batch and the
model reads the client's own words.

Typing and key chords go through the `osk.key` path — every key down and
up as its own message, exactly the sequence the shell's on-screen keyboard
sends (`data/shell/osk.js` in the Viewport repository is the reference:
characters are sent as their base keysym plus a synthesized shift where
needed). Pointer, click and scroll are `input.pointer`, `input.button`
and `input.scroll`.

## Layout

```
index.mjs              the Cordis plugin entry: config schema, service wiring, system prompt
src/messages.mjs       control-message building (`-t <type>` plus fields per action)
src/keys.mjs           text and chords to keystrokes (the osk.js mapping)
src/seat.mjs           message lists to `viewport msg` runs; batch scripts; error shaping
src/shot.mjs           grim capture, PNG sizing, screenshot naming
src/render.mjs         model-facing summaries (screenshot envelope matches read_image's)
src/tool.mjs           the `viewport` tool definition (schema, validation, execution)
test/                  node --test suites over all of the above (fake clients; no session needed)
scripts/               link-dsh-peers.mjs; smoke-e2e.mjs + headless-smoke.sh (below)
examples/mount.yml     the --patch overlay
packaging/nixos/       the NixOS packaging
```

## Testing

- `node --test` — the unit suites (55 tests). No session, no compositor:
  fake clients stand in for `viewport msg` and grim.
- `scripts/headless-smoke.sh` — the real thing, against a throwaway
  `viewport --headless` instance: starts it, then runs the same modules
  end to end (`move`, `click`, `scroll`, `type`, `key`, `screenshot` with
  the real grim, socket discovery). Needs a Viewport checkout built with
  `input.scroll` and mesa's surfaceless EGL (the script sets
  `__EGL_VENDOR_LIBRARY_FILENAMES` and the software renderer, or captures
  fail with "no headless renderer"). It never touches the live session:
  control socket and Wayland socket both live under a private
  `XDG_RUNTIME_DIR` in `/tmp`.
- Through the harness: `dsh headless --patch ./examples/mount.yml "<task
  naming the viewport tool>"` — one task, no UI. With the example's config
  pointed at a smoke instance, this exercises the real mount: schema,
  model call, seat, attachments.

## License

MIT — see `LICENSE`.
