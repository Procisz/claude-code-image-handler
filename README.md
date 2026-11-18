# claude-code-image-handler

A Claude Code mod that shows a preview tile above the prompt for every image you add to the draft: paste, drag and drop, or a typed or `@` path.

- One tile per image, many at once (25 drops give 25 previews).
- A spinner on each tile while its preview is made.
- The full file name under the preview, wrapped onto 2 or 3 lines. Nothing is cut.
- Sharp previews: tiles 20x5 cells, made from 320 px thumbnails, downscaled by area averaging.
- An `open` button at the top left of each tile opens the full image in the system viewer.
- A delete button at the top right of each tile.
- In terminals that draw pictures, a tile says `No preview` when the file cannot be read.
- A clipboard watcher: when you copy a new picture, a `Clipboard picture` tile appears with an `Add` button that puts the picture in the prompt.
- `/paste` adds the clipboard picture at once.
- Works on Windows, macOS and Linux, with the keyboard only or the mouse only.

```
╭──────────────────────────────╮ ╭──────────────────────────────╮
│ open                       x │ │ Add                        x │
│                              │ │                              │
│          (picture)           │ │          (picture)           │
│                              │ │                              │
│ photo.png                    │ │ Clipboard picture            │
╰──────────────────────────────╯ ╰──────────────────────────────╯
ctrl+x tab: focus previews, Tab: next, Enter: press, Esc: back
```

## Install

Add the plugin from the marketplace inside Claude Code:

```
/plugin install image-handler --marketplace Procisz/claude-code-image-handler
```

Or from a shell:

```sh
claude plugin install image-handler --marketplace Procisz/claude-code-image-handler
```

For development, run Claude Code with the plugin loaded from a clone. In the folder where you cloned the repository, check you are in the right place:

```sh
ls package.json
```

Then start Claude Code with the plugin:

```sh
claude --plugin-dir .
```

The mod works in the terminal. The desktop app keeps its own attachment view.

## Usage

A tile appears above the prompt when the draft holds an image in any of these forms:

- A pasted image (the draft shows `[Image #1]`).
- A dropped file.
- A typed path or an `@` path to an image file, plain, in single or double quotes, or as a `file://` URL.

A pasted screenshot gets its preview even when Claude Code writes the image file a moment after the `[Image #1]` tag appears.

Paths can be absolute, relative (`./`, `../`), home based (`~/`) or Windows (`C:\`, `C:/`, `\\server\share`). Only paths that point to an existing file get a tile. The same image twice in the draft is one tile.

To delete an image, press its button (the `x` at the top right of the tile). The preview goes away and the reference is removed from the prompt text, together with one neighbouring space.

To open an image in the system viewer, press the `open` button at the top left of its tile. The picture itself cannot be pressed in Claude Code, so Enter or a click goes to the `open` button above it. Only local picture files open; URLs and network paths (`\\server\share`) are refused with a toast.

## Clipboard

The mod watches the clipboard. When you copy a new picture, a `Clipboard picture` tile appears after the file tiles. Press its `Add` button to put the picture path in the prompt, or its `x` button to dismiss it. A picture that was already on the clipboard when the session started, or when watching was switched on, is not offered.

Two commands work with the clipboard:

- `/paste` adds the clipboard picture to the prompt at once.
- `/paste auto on` and `/paste auto off` switch the watching for the session. `/paste auto` alone tells you the current state.

To start a session with watching off, set the plugin option `clipboard_watch` ("Watch the clipboard") to `false`. It is `true` by default. `/paste auto on|off` lasts for the session only.

## Keyboard

1. Press `ctrl+x`, then `Tab`, to focus the previews.
2. Walk the buttons (`open`, `Add`, `x`) with `Tab` or the arrow keys.
3. Press `Enter` to press the focused button: open the image, add the clipboard picture, or delete or dismiss a tile.
4. Press `Esc` to return to the prompt.

## Mouse

Click `open` to open an image in the viewer, `Add` to add the clipboard picture, and `x` to delete or dismiss a tile. Mouse clicks reach the buttons only where the terminal reports clicks, which is the fullscreen layout.

## Formats and tools

The mod first asks the system to read the image, and falls back to its own decoders.

| OS | System tools, in order |
| --- | --- |
| macOS | `sips`, then ImageMagick (`magick`, `convert`) |
| Linux | ImageMagick (`magick`, then `convert`) |
| Windows | PowerShell with WIC, then System.Drawing, then ImageMagick (`magick.exe`) |

Whatever the system tools can read gets a preview, so odd formats work when a tool supports them: TIFF, HEIC, AVIF, SVG, ICO, ICNS, PSD, RAW camera files and more. A missing tool is skipped for the rest of the session.

If no tool can read a file, the built-in decoders try these formats: PNG, baseline JPEG, GIF (first frame), BMP and PNM. In terminals that draw pictures, any other file shows `No preview`.

## Clipboard tools

| OS | Tool |
| --- | --- |
| macOS | `osascript` |
| Windows | PowerShell |
| Linux | `wl-paste` or `xclip` |

On Linux, `wl-paste` is tried first when `WAYLAND_DISPLAY` is set, otherwise `xclip`; the other is the fallback. Only copied picture data is read, not copied image files.

## Pictures and names

In terminals that draw pictures (kitty, Ghostty, and iTerm2 3.5 or later in the fullscreen layout) the tile shows the picture. The picture is centered in a fixed 20x5 cell box.

In other terminals (Terminal.app, tmux, screen) the tile shows no picture. It is a small tile with its buttons (`open` and `x`, or `Add` and `x`) and the full file name, wrapped onto 2 or 3 lines. Nothing is cut.

To force one, set `CLAUDE_IMAGE_HANDLER_RENDERER` to `image` (always show the picture) or `blocks` (always show the name-only tile).

## What it reads, runs and writes

- Reads the image files named in your draft and the images Claude Code caches for pasted images.
- Reads the clipboard about every 1.5 seconds while watching is on.
- Runs the system tools listed above, without a shell. On Windows the file path is passed to PowerShell through an environment variable, never inside the script text.
- Runs `open` (macOS), `xdg-open` (Linux) or PowerShell `Start-Process` (Windows) on a local picture file when you press `open`.
- Writes one temporary PNG per image in the system temp folder, and deletes it right after reading it.
- Saves each copied clipboard picture as `<temp>/claude-image-handler/clipboard-*.png` and removes it at session end. A crash leaves the files there.
- Makes no network requests. Nothing else on your machine changes.

## Known limits

- Mouse clicks on the delete button work only in the fullscreen layout. Use the keyboard in other layouts.
- The picture itself cannot be pressed in Claude Code. Use the `open` button above it.
- Terminal.app cannot show pictures, only the file name, and cannot catch Cmd+V of an image, so the watcher polls the clipboard instead.
- Windows and Linux tools are only tested through simulation; macOS is the only system tried by hand.
- Claude Code keeps its own record of pasted images. How it reacts when a pasted image's tag is removed from the prompt is not yet verified, so this README promises only that the preview and the reference in the prompt text are removed.

## Troubleshooting

- No tile appears: the path must point to an existing file with an image extension, and the surface must be the terminal.
- `No preview` on a common format: the file may be corrupt, or no system tool can read it. Install ImageMagick and try again.
- No picture, only the name: your terminal does not draw pictures. Set `CLAUDE_IMAGE_HANDLER_RENDERER=image` to try anyway.
- Clicks do nothing: switch to the fullscreen layout, or use the keyboard.
- No `Clipboard picture` tile: check that watching is on (`/paste auto`) and that the tool for your system is installed. A picture copied before watching started is not offered; copy it again, or run `/paste`.
- `open` shows `Could not open the image`: the file is missing, is not local, or the system opener failed.
- `/paste` says it could not read the clipboard: install `osascript` (macOS), PowerShell (Windows), or `wl-paste` or `xclip` (Linux).

## Development

In the folder where you cloned the repository:

```sh
npm install
```

```sh
npm run typecheck
```

```sh
npm run coverage
```

```sh
npm run validate
```

`npm run coverage` runs the vitest suite and fails below 100% coverage.

The Claude Code mod API types live in `typings/claude-code/index.d.ts`, a verbatim copy of the file bundled with Claude Code's plugin-authoring skill. To regenerate it, copy the newer `claude-code.d.ts` from that skill over it without editing.

## License

MIT, see [LICENSE](LICENSE).
