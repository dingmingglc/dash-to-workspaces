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

## 用户操作说明（简要）

1. **启用扩展**  
   安装后，在「扩展」应用里打开 **Dash to Workspaces**，或运行：  
   `gnome-extensions enable dash-to-workspaces@dingmingglc`  
   必要时注销/重新登录或按 Alt+F2 输入 `r` 重启 GNOME Shell。

2. **面板与任务栏**  
   - 应用图标和系统托盘会出现在主面板上（类似 Windows 任务栏）。  
   - 在扩展设置里可改 **Position**：面板在屏幕顶部、底部、左侧或右侧，以及高度、不透明度等。

3. **工作区预览**  
   - 面板上会显示当前所有工作区的小预览；点击某个预览可切换工作区。  
   - 可在预览上拖拽窗口图标，把窗口移到对应工作区；相关选项在设置的 **Behavior** 等中。

4. **智能隐藏（可选）**  
   - 默认**不隐藏**面板。若需自动隐藏，在扩展设置中打开 **Intellihide**，并可按需配置「用指针显示」「根据窗口隐藏」等。

5. **打开设置**  
   - 在「扩展」里点击本扩展旁的齿轮，或运行：  
   `gnome-extensions prefs dash-to-workspaces@dingmingglc`

6. **恢复默认**  
   - 在终端执行：  
   `dconf reset -f /org/gnome/shell/extensions/dash-to-workspaces/`  
   然后重启 GNOME Shell。

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

- GNOME Shell 48 或 49（以 `metadata.json` 中 `shell-version` 为准）。

---

## Settings

Configure via **GNOME Extensions** or **dconf Editor** under:

`/org/gnome/shell/extensions/dash-to-workspaces/`

Reset to defaults:

```bash
dconf reset -f /org/gnome/shell/extensions/dash-to-workspaces/
```

---

## 发布前检查（Publishing checklist）

发布到 GitHub 或 [extensions.gnome.org](https://extensions.gnome.org/) 前建议确认：

| 项目 | 说明 |
|------|------|
| **metadata.json** | `name`、`description`、`uuid`、`url`、`shell-version`、`version` 正确；`uuid` 与扩展文件夹名一致（如 `dash-to-workspaces@dingmingglc`）。 |
| **许可证** | [COPYING](COPYING) 存在且为 GPL-2.0-or-later；README 中注明 License。 |
| **敏感信息** | 代码与配置中无 API Key、密码、Personal Access Token 等；`.cursor/` 规则里若提到 token 仅作说明，勿把真实 token 提交进仓库。 |
| **.gitignore** | 建议忽略 `.git/`、`.cursor/` 等，避免把本地/IDE 配置推上去；若用 GitHub，可再忽略 `*.mo` 的本地编译产物（可选，因 .mo 通常需随仓库发布以便离线安装）。 |
| **扩展网站 zip** | 上传到 extensions.gnome.org 时，zip 内为扩展**根目录下的所有文件**（如 `extension.js`、`metadata.json`、`schemas/`、`locale/` 等），不要多一层以 UUID 命名的父文件夹（按网站要求）。 |
| **shell-version** | 与当前 GNOME 版本对应；仅写你测试过的版本（如 `["48","49"]`），避免承诺未测试版本。 |

当前已知差异或注意点：

- **README 与 metadata**：若你修改了 `metadata.json` 的 `shell-version`，请同步改 README 的 Requirements 小节。
- **.gitignore**：若仓库根目录尚无 `.gitignore`，建议新建并加入 `.cursor/` 等，避免误提交。

---

## License

GPL-2.0-or-later. See [COPYING](COPYING).

---

## Credits

- Based on [Dash to Panel](https://github.com/home-sweet-gnome/dash-to-panel) (by jderose9, charlesg99 and contributors).
- Code and ideas from [Dash-to-Dock](https://github.com/micheleg/dash-to-dock), [ZorinOS Taskbar](https://github.com/ZorinOS/zorin-taskbar), and other projects as noted in the source files.
