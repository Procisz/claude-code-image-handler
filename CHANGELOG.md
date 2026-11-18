# Changelog

## [Unreleased]

### Added

- An `open` button on each tile that opens the image in the system viewer. The picture itself cannot be pressed, so Enter or a click uses this button.
- A clipboard watcher and a `Clipboard picture` tile with an `Add` button and a dismiss button.
- The `/paste` command, which adds the clipboard picture to the prompt.
- `/paste auto on|off` to switch the clipboard watching for the session.
- The `clipboard_watch` plugin option (default on).

### Changed

- Tiles are a fixed 20x5 cells with the picture centered, instead of up to 40x16 cells.
- Sharper previews: thumbnails are 320 px and are downscaled by exact area averaging in linear light, so text and thin lines keep their contrast.
- Terminals without pictures (Terminal.app, tmux, screen) show a small name-only tile: no picture, no quadrant blocks.
- File names wrap onto 2 or 3 lines instead of being cut to `[name...].ext`.

### Fixed

- The first screenshot pasted from the clipboard no longer ends as `No preview` when Claude Code writes its cache file or folder a moment after the `[Image #1]` tag; failed loads are retried for 3 seconds.

## [0.1.0]

### Added

- Preview tile above the prompt for every image added to the draft: paste, drag and drop, typed or `@` path.
- Many images at once, one tile each.
- A spinner on each tile while its preview is made.
- The file name under each preview, long names cut with the extension kept, like `[kzt  gsddgsa...].jpg`.
- A delete button at the top right of each tile that removes the preview and the reference from the prompt.
- A `No preview` tile for files that cannot be read.
- Previews on Windows, macOS and Linux through system tools (sips, PowerShell WIC and System.Drawing, ImageMagick), with built-in PNG, baseline JPEG, GIF, BMP and PNM decoders as fallback.
- Keyboard use (`ctrl+x tab`, `Tab` or arrows, `Enter`, `Esc`) and mouse use (fullscreen layout).
- Pictures in terminals that draw them, half blocks elsewhere, and the `CLAUDE_IMAGE_HANDLER_RENDERER` setting (`image` or `blocks`).
