# Dash to Workspaces

Icon taskbar for GNOME Shell with built-in **workspace previews**. Moves the dash into the main panel so application launchers and system tray are combined in a single panel (similar to KDE Plasma or Windows 7+). No separate dock needed.

**Author / Contact:** dingmingglc@gmail.com

---

## Features

- **Taskbar in panel** — Running and favorited applications in the main panel (top, bottom, left, or right).
- **Workspace previews** — Thumbnails of all workspaces with optional app icons per workspace; click or drag windows/icons between workspaces.
- **Shortcuts bar** — Optional row of favorite app shortcuts below the previews.
- **Intellihide** — Auto-hide panel with configurable reveal (edge only or full panel area) and hide-only-when-pointer-leaves behavior.
- **Compatibility** — Optional avoidance of Dash to Panel overlap (e.g. use work area for panel position).
- **Customization** — Positions, sizes, transparency, window previews, scroll actions, and more.

Based on [Dash to Panel](https://github.com/home-sweet-gnome/dash-to-panel); extended with workspace preview and related options.

---

## Languages

- **English** — Default (source strings in code).
- **中文（简体）** — `locale/zh_CN/LC_MESSAGES/dash-to-workspaces.mo`。
- **gettext 域名**：`dash-to-workspaces`（`metadata.json` 中 `gettext-domain`）。更新翻译：编辑 `locale/zh_CN/LC_MESSAGES/dash-to-workspaces.po` 后运行 `msgfmt -o locale/zh_CN/LC_MESSAGES/dash-to-workspaces.mo locale/zh_CN/LC_MESSAGES/dash-to-workspaces.po`。

---

## Version

- **Release version:** see [VERSION](VERSION) (e.g. `1.0.0` for tagging releases).
- **Extension version:** integer in `metadata.json` (used by GNOME for update checks and “See what’s new” link).

---

## Publishing to GitHub

To create your own repository and push this extension:

1. **Create a new repository on GitHub**
   - Go to [github.com/new](https://github.com/new).
   - Name it e.g. `dash-to-workspaces` (or any name you prefer).
   - Do **not** initialize with README, .gitignore, or license (you already have them).
   - Create the repository and copy its URL (e.g. `https://github.com/dingmingglc/dash-to-workspaces.git`).

2. **Point this project to your new repo and push**
   - In the extension folder, set the remote to your new repo and push:
   ```bash
   cd ~/.local/share/gnome-shell/extensions/dash-to-workspaces@dingmingglc
   git remote set-url origin https://github.com/YOUR_USERNAME/dash-to-workspaces.git
   git add -A
   git commit -m "Release v1.0.0"
   git push -u origin master
   ```
   - Replace `YOUR_USERNAME` with your GitHub username. If your default branch is `main` instead of `master`, use `git push -u origin main` (and optionally rename the branch first).

3. **Optional: create a release**
   - On GitHub: **Releases** → **Create a new release** → tag `v1.0.0` (matching [VERSION](VERSION)) and publish.

---

## Installation

### From source (manual)

1. Download or clone this extension.
2. Ensure the extension folder name is exactly: **`dash-to-workspaces@dingmingglc`** (must match `uuid` in `metadata.json`).
3. Copy the folder into:
   - **System-wide:** `/usr/share/gnome-shell/extensions/`
   - **Per-user:** `~/.local/share/gnome-shell/extensions/`
4. Enable the extension:
   - GNOME Extensions app, or
   - `gnome-extensions enable dash-to-workspaces@dingmingglc`
5. Restart GNOME Shell (e.g. log out and back in, or Alt+F2 → `r`).

### After publishing to GNOME Extensions

Once the extension is published on [extensions.gnome.org](https://extensions.gnome.org/), you can install it from there with one click.

---

## GNOME extension standard (folder name & publishing)

- **Folder name** must equal the **UUID** in `metadata.json`. This extension uses:
  - **UUID:** `dash-to-workspaces@dingmingglc`
  - **Folder:** `dash-to-workspaces@dingmingglc`
- To publish on [extensions.gnome.org](https://extensions.gnome.org/):
  1. Set `url` in `metadata.json` to your project URL (e.g. your GitHub repo).
  2. Create a **zip** of the extension (contents of the extension folder; no parent folder named after uuid in the zip for some workflows).
  3. Create an account and upload the zip, or link a Git repository.
  4. Ensure `metadata.json` has correct `name`, `description`, `uuid`, `shell-version`, `version`, and `url`.
- If you want a different UUID (e.g. `dash-to-workspaces@dingmingglc`), change both `uuid` in `metadata.json` and the folder name to match.

---

## Requirements

- GNOME Shell 46, 47, 48, or 49 (see `metadata.json` → `shell-version`).

---

## Settings

Configure via **GNOME Extensions** or **dconf Editor** under:

`/org/gnome/shell/extensions/dash-to-workspaces/`

Reset to defaults:

```bash
dconf reset -f /org/gnome/shell/extensions/dash-to-workspaces/
```

---

## License

GPL-2.0-or-later. See [COPYING](COPYING).

---

## Credits

- Based on [Dash to Panel](https://github.com/home-sweet-gnome/dash-to-panel) (by jderose9, charlesg99 and contributors).
- Code and ideas from [Dash-to-Dock](https://github.com/micheleg/dash-to-dock), [ZorinOS Taskbar](https://github.com/ZorinOS/zorin-taskbar), and other projects as noted in the source files.
