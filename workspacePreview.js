/*
 * Workspace Preview View
 * Displays a preview of all workspaces with their windows and names
 */

import Clutter from 'gi://Clutter'
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import GObject from 'gi://GObject'
import St from 'gi://St'
import Meta from 'gi://Meta'
import Shell from 'gi://Shell'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import * as WorkspaceThumbnail from 'resource:///org/gnome/shell/ui/workspaceThumbnail.js'
import * as Background from 'resource:///org/gnome/shell/ui/background.js'
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js'
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js'
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js'
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js'

import * as Utils from './utils.js'
import * as AppIcons from './appIcons.js'
import { SETTINGS } from './extension.js'
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js'

const PREVIEW_HEIGHT = 120
const NAME_HEIGHT = 30
const WM_PREFS_SCHEMA = 'org.gnome.desktop.wm.preferences'
const APP_ICON_SIZE = 32
const APP_ICON_MAX = 8

export const WorkspacePreviewView = GObject.registerClass(
  {},
  class WorkspacePreviewView extends St.Widget {
    _init(panel) {
      super._init({
        layout_manager: new Clutter.BoxLayout({
          orientation: Clutter.Orientation.VERTICAL,
          spacing: SETTINGS.get_int('workspace-preview-spacing'),
        }),
        style_class: 'workspace-preview-view',
        reactive: true,
      })

      this.panel = panel
      this._workspaceItems = []
      this._signalsHandler = new Utils.GlobalSignalsHandler()
      this._timeoutsHandler = new Utils.TimeoutsHandler()
      this._iconMenuManager = new PopupMenu.PopupMenuManager(this)
      this._dragInProgress = false
      this._iconDrag = null
      this._lastWorkAreaKey = null
      this._didInitialWindowRefresh = false
      this._dropHighlightItem = null
      // window->app 缓存（WeakMap：窗口销毁时自动清理）
      this._windowAppCache = new WeakMap()
      this._tracker = Shell.WindowTracker.get_default()

      // 在整个预览区域内滚轮切换 workspace（与任务栏一致）
      // 用 panel 的原始滚轮逻辑，保证设置项/行为完全一致
      this._signalsHandler.add([
        this,
        'scroll-event',
        (_actor, event) => {
          // 复用 Panel._onPanelMouseScroll（它会根据设置决定切换工作区/切换窗口/音量等）
          this.panel?._onPanelMouseScroll?.(this, event)
          return Clutter.EVENT_STOP
        },
      ])

      // 在整个预览视图上右键切换 intellihide（包括空白区域）
      this._signalsHandler.add([
        this,
        'button-press-event',
        (actor, event) => this._handleRightClick(actor, event),
      ])

      // 监听设置变化
      this._connectSettingsSignals()

      // 监听工作区变化
      this._connectSignals()

      // 监听扩展状态变化（用于检测 Dash to Panel）
      this._extensionManager = Main.extensionManager
      this._extensionStateChangedId = this._extensionManager.connect(
        'extension-state-changed',
        () => {
          // Dash to Panel 状态变化时更新布局
          this._timeoutsHandler.add([
            'ws-preview-dtp-check',
            100,
            () => this._updateLayout(),
          ])
        },
      )

      // 初始更新
      this._updateWorkspaces()

      // 延迟更新布局和可见性，确保面板已经布局完成
      GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        this._updateLayout()
        this._updateVisibility()
        return GLib.SOURCE_REMOVE
      })
    }

    _connectSettingsSignals() {
      this._signalsHandler.add(
        [
          SETTINGS,
          'changed::workspace-preview-position-outside',
          () => this._updateLayout(),
        ],
        [
          SETTINGS,
          'changed::workspace-preview-display-mode',
          () => this._updateVisibility(),
        ],
        [
          SETTINGS,
          'changed::workspace-preview-width',
          () => {
            this._updateLayout()
            this._updateWorkspaces()
          },
        ],
        [SETTINGS, 'changed::workspace-preview-spacing', () => this._updateWorkspaces()],
        [
          SETTINGS,
          'changed::workspace-preview-name-position',
          () => this._updateWorkspaces(),
        ],
        [
          SETTINGS,
          'changed::workspace-preview-avoid-dash-to-panel',
          () => this._updateLayout(),
        ],
      )
    }

    _updateVisibility() {
      let displayMode = SETTINGS.get_string('workspace-preview-display-mode')
      let showPanel = displayMode == 'PANEL' || displayMode == 'BOTH'
      let showPreview = displayMode == 'PREVIEW' || displayMode == 'BOTH'

      // 控制任务栏面板显示（任务栏面板是 this.panel.panel）
      if (this.panel && this.panel.panel) {
        this.panel.panel.visible = showPanel
      }

      // 控制预览显示
      this.visible = showPreview
      
      // 更新布局
      this._updateLayout()
    }

    _updateLayout() {
      if (!this.panel) {
        return
      }

      let previewThickness = SETTINGS.get_int('workspace-preview-width')
      let geom = this.panel.geom
      let isSidePanel = geom.position == St.Side.LEFT || geom.position == St.Side.RIGHT

      // 预览区域：固定“厚度”，其余方向填满
      if (isSidePanel) {
        // 左/右面板：左右两列，预览固定宽度，二者都从上到下铺满
        this.set_width(previewThickness)
        this.set_height(-1)
        this.x_expand = false
        this.y_expand = true
        this.set_margin_top(0)
      } else {
        // 上/下面板：上下两行，预览固定高度，二者都从左到右铺满
        this.set_width(-1)
        this.set_height(previewThickness)
        this.x_expand = true
        this.y_expand = false
        this.set_margin_top(0)
      }
    }

    _connectSignals() {
      let workspaceManager = Utils.DisplayWrapper.getWorkspaceManager()
      let display = global.display

      this._signalsHandler.add(
        // workspace 切换时，更新当前选中缩略图
        [
          workspaceManager,
          'active-workspace-changed',
          () => {
            // 用 TimeoutsHandler 做去抖（避免连续触发导致频繁样式抖动）
            this._timeoutsHandler.add([
              'ws-preview-active-state',
              0,
              () => this._updateActiveState(),
            ])
          },
        ],
        [
          workspaceManager,
          'workspace-added',
          () => {
            // 频繁增删 workspace 时合并为一次重建
            this._timeoutsHandler.add([
              'ws-preview-rebuild',
              100,
              () => this._updateWorkspaces(),
            ])
          },
        ],
        [
          workspaceManager,
          'workspace-removed',
          () => {
            this._timeoutsHandler.add([
              'ws-preview-rebuild',
              100,
              () => this._updateWorkspaces(),
            ])
          },
        ],
        // workarea/monitor 变化时重建预览（解决启动时 workarea 尚未就绪）
        [
          Main.layoutManager,
          'workareas-changed',
          () => {
            // 只有 workarea 真变化才重建，避免输入法/OSD 等频繁触发导致“跳动”
            let key = this._getWorkAreaKey()
            if (key && this._lastWorkAreaKey === key) return
            this._lastWorkAreaKey = key
            this._timeoutsHandler.add([
              'ws-preview-workarea-geom',
              80,
              () => this._updateWorkspacesGeometry(),
            ])
          },
        ],
        [
          Main.layoutManager,
          'monitors-changed',
          () => {
            this._timeoutsHandler.add([
              'ws-preview-monitors',
              100,
              () => this._updateWorkspaces(),
            ])
          },
        ],
        // 启动后第一次创建窗口时再刷新一次，确保 workarea 已就绪
        [
          display,
          'window-created',
          () => {
            // 只在启动后第一次创建窗口时刷新一次，避免后续 transient window 触发重建
            if (this._didInitialWindowRefresh) return
            this._didInitialWindowRefresh = true
            this._timeoutsHandler.add([
              'ws-preview-first-window',
              150,
              () => this._updateWorkspaces(),
            ])
          },
        ],
        // 注意：不要在窗口事件上重建整个列表。
        // `WorkspaceThumbnail` 内部已经跟踪 workspace 的 window-added/removed、
        // minimize/position 等变化；我们这里只需要处理 workspace 数量与激活态即可，
        // 否则切换 workspace 时会因为重建导致抖动/闪动。
        // focus-window 变化时，只更新图标 focused 样式，不重建列表
        [
          display,
          'notify::focus-window',
          () => {
            this._timeoutsHandler.add([
              'ws-preview-focus-update',
              0,
              () => this._updateFocusedIcons(),
            ])
          },
        ],
      )
    }

    _getWorkAreaKey() {
      try {
        let wa = Main.layoutManager.getWorkAreaForMonitor(this.panel.monitor.index)
        if (!wa) return null
        return `${wa.x},${wa.y},${wa.width},${wa.height}`
      } catch (e) {
        return null
      }
    }


    _updateWorkspacesGeometry() {
      // 仅更新缩略图/背景的 scale 和 position，避免重建导致卡顿
      if (!this.panel || !this._workspaceItems.length) return

      let previewWidth = SETTINGS.get_int('workspace-preview-width')
      let previewHeight = PREVIEW_HEIGHT
      let wa = null
      try {
        wa = Main.layoutManager.getWorkAreaForMonitor(this.panel.monitor.index)
        if (wa && wa.width > 0 && wa.height > 0) {
          previewHeight = Math.max(80, Math.round((previewWidth * wa.height) / wa.width))
        }
      } catch (e) {
        wa = null
      }

      for (let item of this._workspaceItems) {
        if (!item?._dtwPreviewArea || !item?._dtwPreviewStack) continue

        item._dtwPreviewStack.set_size(previewWidth, previewHeight)
        item._dtwPreviewArea.set_size(previewWidth, previewHeight)

        if (wa && wa.width > 0 && wa.height > 0) {
          let scale = Math.max(previewWidth / wa.width, previewHeight / wa.height)
          let contentW = wa.width * scale
          let contentH = wa.height * scale
          let x = Math.floor((previewWidth - contentW) / 2)
          let y = Math.floor((previewHeight - contentH) / 2)

          try {
            item._dtwBackgroundGroup?.set_scale?.(scale, scale)
            item._dtwBackgroundGroup?.set_position?.(x, y)
          } catch (e) {
            // ignore
          }
          try {
            item._dtwThumbnail?.setScale?.(scale, scale)
            item._dtwThumbnail?.set_position?.(x, y)
          } catch (e) {
            // ignore
          }
        }

        // 叠加层重算位置
        try {
          item._dtwUpdateLabelPos?.()
        } catch (e) {
          // ignore
        }
      }
    }

    _applyNameLabelActiveStyle(nameLabel, isActive) {
      if (!nameLabel) return
      // 统一管理 label 样式，切换激活态只改颜色，避免重建造成闪动
      nameLabel.style = `font-size: 12px; color: ${
        isActive ? 'white' : 'rgba(255,255,255,0.85)'
      }; background-color: rgba(0,0,0,0.55); padding: 4px 8px; border-radius: 6px;`
    }

    _handleRightClick(_actor, event) {
      // 统一的右键处理：切换 intellihide 状态（如果不在图标上）
      try {
        let button = event.get_button()
        if (button === 3) {
          // 检查是否点击在图标上（如果是，不处理，让图标菜单显示）
          let [stageX, stageY] = event.get_coords()
          let pickActor = global.stage.get_actor_at_pos(
            Clutter.PickMode.REACTIVE,
            stageX,
            stageY,
          )
          // 如果点击在图标按钮上，不处理（让图标菜单显示）
          if (pickActor && pickActor._dtwApp) {
            return Clutter.EVENT_PROPAGATE
          }
          // 切换 intellihide 状态
          let currentState = SETTINGS.get_boolean('intellihide')
          SETTINGS.set_boolean('intellihide', !currentState)
          return Clutter.EVENT_STOP
        }
      } catch (e) {
        // ignore
      }
      return Clutter.EVENT_PROPAGATE
    }

    _setDropHighlightItem(item) {
      if (this._dropHighlightItem === item) return
      try {
        this._dropHighlightItem?.remove_style_class_name?.('workspace-preview-drop-target')
      } catch (e) {
        // ignore
      }
      this._dropHighlightItem = item
      try {
        this._dropHighlightItem?.add_style_class_name?.('workspace-preview-drop-target')
      } catch (e) {
        // ignore
      }
    }

    _listWorkspaceWindows(workspace) {
      try {
        return (workspace?.list_windows?.() ?? []).filter((w) => w && !w.skip_taskbar)
      } catch (e) {
        return []
      }
    }

    _getWindowApp(window) {
      // 使用缓存避免重复查询 tracker.get_window_app
      if (this._windowAppCache.has(window)) {
        return this._windowAppCache.get(window)
      }
      let app = null
      try {
        app = this._tracker.get_window_app(window)
      } catch (e) {
        app = null
      }
      if (app) {
        this._windowAppCache.set(window, app)
      }
      return app
    }

    _getUniqueAppsFromWindows(windows) {
      // 按“最近使用”排序（用窗口 user_time 的最大值）
      let map = new Map() // id -> { app, t }
      for (let w of windows) {
        let app = this._getWindowApp(w)
        if (!app) continue

        let id = null
        try {
          id = app.get_id()
        } catch (e) {
          id = null
        }
        if (!id) id = app.get_name?.() || String(app)

        let t = 0
        try {
          t = w.get_user_time?.() ?? 0
        } catch (e) {
          t = 0
        }

        let prev = map.get(id)
        if (!prev || t > prev.t) map.set(id, { app, t })
      }

      return Array.from(map.values())
        .sort((a, b) => (b.t ?? 0) - (a.t ?? 0))
        .map((x) => x.app)
    }

    _getWindowsForAppInWorkspace(app, workspace, tracker) {
      return this._listWorkspaceWindows(workspace).filter((w) => {
        return this._getWindowApp(w) === app
      })
    }

    _activateBestWindowOrApp(app, windows) {
      // 更像任务栏：优先激活当前聚焦窗口，否则激活最近使用窗口
      try {
        let focus = global.display.focus_window
        if (focus && windows?.includes?.(focus)) {
          Main.activateWindow(focus)
          return
        }
      } catch (e) {
        // ignore
      }

      let best = null
      let bestT = -1
      for (let w of windows || []) {
        let t = 0
        try {
          t = w.get_user_time?.() ?? 0
        } catch (e) {
          t = 0
        }
        if (t > bestT) {
          bestT = t
          best = w
        }
      }
      if (best) {
        Main.activateWindow(best)
        return
      }

      try {
        app.activate()
      } catch (e) {
        // ignore
      }
    }

    _ensureAppIconMenu(iconButton, app, workspace, tracker) {
      if (iconButton._dtwMenu) return

      let menu = new PopupMenu.PopupMenu(iconButton, 0.5, this.panel.geom.position)
      menu.blockSourceEvents = true
      Main.uiGroup.add_child(menu.actor)
      this._iconMenuManager.addMenu(menu)

      // New Window
      menu.addAction(_('New Window'), () => {
        try {
          if (app.open_new_window) app.open_new_window(-1)
          else app.activate()
        } catch (e) {
          try {
            app.activate()
          } catch (e2) {
            // ignore
          }
        }
      })

      menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem())

      // Quit (this workspace)
      let quitHere = menu.addAction(_('Quit (This Workspace)'), () => {
        let wsWindows = this._getWindowsForAppInWorkspace(app, workspace, tracker)
        for (let w of wsWindows) {
          try {
            w.delete(global.get_current_time())
          } catch (e) {
            // ignore
          }
        }
      })

      // Quit (all)
      let quitAll = menu.addAction(_('Quit'), () => {
        AppIcons.closeAllWindows(app, this.panel.monitor)
      })

      menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem())

      // Pin/Unpin favorite (best effort)
      let favs = AppFavorites.getAppFavorites()
      let appId = null
      try {
        appId = app.get_id()
      } catch (e) {
        appId = null
      }
      let isFav = false
      try {
        isFav = !!(appId && favs.isFavorite(appId))
      } catch (e) {
        isFav = false
      }
      let pinItem = menu.addAction(isFav ? _('Unpin') : _('Pin'), () => {
        try {
          if (!appId) return
          if (favs.isFavorite(appId)) {
            favs.removeFavorite(appId)
          } else {
            let pos = 0
            try {
              pos = favs.getFavorites().length
            } catch (e) {
              pos = 0
            }
            favs.addFavoriteAtPos(appId, pos)
          }
          favs.emit('changed')
        } catch (e) {
          // ignore
        }
      })

      menu.connect('destroy', () => {
        iconButton._dtwMenu = null
      })

      iconButton._dtwMenu = menu
      iconButton._dtwQuitAllItem = quitAll
      iconButton._dtwQuitHereItem = quitHere
      iconButton._dtwPinItem = pinItem
    }

    _createPreviewAppIconButton({ app, workspace, iconSize, tracker }) {
      let iconActor = null
      try {
        iconActor = new St.Icon({
          gicon: app.get_icon(),
          icon_size: iconSize,
          style_class: 'workspace-preview-app-icon',
        })
      } catch (e) {
        iconActor = null
      }
      if (!iconActor) return null

      let iconButton = new St.Button({
        reactive: true,
        track_hover: true,
        can_focus: false,
        style_class: 'workspace-preview-app-icon-clickable',
      })
      iconButton.set_size(iconSize, iconSize)
      iconButton.set_child(iconActor)

      // focused app 高亮（初始状态，后续由 _updateFocusedIcons 更新）
      iconButton._dtwApp = app
      iconButton._dtwWorkspace = workspace
      this._updateIconFocusedState(iconButton)

      // 单一 handler：左键拖拽/激活，右键菜单
      iconButton.connect('button-press-event', (_actor, event) => {
        let btn = 1
        try {
          btn = event.get_button()
        } catch (e) {
          btn = 1
        }

        // 右键菜单
        if (btn === 3) {
          this._ensureAppIconMenu(iconButton, app, workspace, tracker)
          let countAll = AppIcons.getInterestingWindows(app, this.panel.monitor).length
          let countHere = this._getWindowsForAppInWorkspace(app, workspace, tracker).length
          iconButton._dtwQuitAllItem.setSensitive(countAll > 0)
          iconButton._dtwQuitHereItem.setSensitive(countHere > 0)
          iconButton._dtwMenu.open(BoxPointer.PopupAnimation.FULL)
          this._iconMenuManager.ignoreRelease()
          return Clutter.EVENT_STOP
        }

        // 左键：启动自定义拖拽（松开未移动则当作点击激活）
        if (btn === 1) {
          let [sx, sy] = event.get_coords()
          let appWindows = this._getWindowsForAppInWorkspace(app, workspace, tracker)
          this._startAppIconDrag({
            app,
            sourceWorkspace: workspace.index(),
            windows: appWindows,
            iconSize,
            startX: sx,
            startY: sy,
          })
          return Clutter.EVENT_STOP
        }

        return Clutter.EVENT_PROPAGATE
      })

      return iconButton
    }

    _cancelIconDrag() {
      if (!this._iconDrag) return
      this._setDropHighlightItem(null)
      try {
        if (this._iconDrag.stageSignalId)
          global.stage.disconnect(this._iconDrag.stageSignalId)
      } catch (e) {
        // ignore
      }
      try {
        this._iconDrag.ghost?.destroy?.()
      } catch (e) {
        // ignore
      }
      this._iconDrag = null
    }

    _findWorkspaceItemAtStageCoords(stageX, stageY) {
      // 拖拽过程中优先用缓存 bounds（减少每次 motion 的 allocation 查询）
      if (this._iconDrag?.bounds) {
        for (let b of this._iconDrag.bounds) {
          if (
            stageX >= b.x1 &&
            stageX <= b.x2 &&
            stageY >= b.y1 &&
            stageY <= b.y2
          ) {
            return b.item
          }
        }
      }
      return null
    }

    _findWorkspaceIndexAtStageCoords(stageX, stageY) {
      let item = this._findWorkspaceItemAtStageCoords(stageX, stageY)
      return item ? item._dtwIndex : null
    }

    _startAppIconDrag({ app, sourceWorkspace, windows, iconSize, startX, startY }) {
      this._cancelIconDrag()

      // 读取系统拖拽阈值（fallback 8px）
      let threshold = 8
      try {
        let s = Clutter.Settings.get_default()
        threshold =
          s?.dnd_drag_threshold ??
          s?.drag_threshold ??
          s?.get_property?.('dnd-drag-threshold') ??
          8
      } catch (e) {
        threshold = 8
      }
      let threshold2 = threshold * threshold

      let ghost = null
      try {
        ghost = new St.Icon({
          gicon: app.get_icon(),
          icon_size: iconSize,
          style: 'opacity: 0.9;',
        })
        Main.uiGroup.add_child(ghost)
        ghost.set_position(Math.floor(startX - iconSize / 2), Math.floor(startY - iconSize / 2))
      } catch (e) {
        ghost = null
      }

      this._iconDrag = {
        app,
        sourceWorkspace,
        windows,
        iconSize,
        startX,
        startY,
        dragging: false,
        ghost,
        stageSignalId: 0,
        threshold2,
        bounds: this._workspaceItems
          .map((item) => {
            if (!item) return null
            try {
              let [ix, iy] = item.get_transformed_position()
              let box = item.get_allocation_box()
              let w = box.x2 - box.x1
              let h = box.y2 - box.y1
              return { item, x1: ix, y1: iy, x2: ix + w, y2: iy + h }
            } catch (e) {
              return null
            }
          })
          .filter(Boolean),
      }

      this._iconDrag.stageSignalId = global.stage.connect('captured-event', (_actor, event) => {
        if (!this._iconDrag) return Clutter.EVENT_PROPAGATE

        let t = null
        try {
          t = event.type()
        } catch (e) {
          return Clutter.EVENT_PROPAGATE
        }

        if (t === Clutter.EventType.KEY_PRESS) {
          try {
            if (event.get_key_symbol?.() === Clutter.KEY_Escape) {
              this._cancelIconDrag()
              return Clutter.EVENT_STOP
            }
          } catch (e) {
            // ignore
          }
          return Clutter.EVENT_PROPAGATE
        }

        if (t === Clutter.EventType.MOTION) {
          let [x, y] = event.get_coords()
          let dx = x - this._iconDrag.startX
          let dy = y - this._iconDrag.startY
          if (!this._iconDrag.dragging) {
            if (dx * dx + dy * dy < this._iconDrag.threshold2) {
              return Clutter.EVENT_STOP
            }
            this._iconDrag.dragging = true
          }
          // 高亮目标 workspace
          this._setDropHighlightItem(this._findWorkspaceItemAtStageCoords(x, y))
          if (this._iconDrag.ghost) {
            this._iconDrag.ghost.set_position(
              Math.floor(x - this._iconDrag.iconSize / 2),
              Math.floor(y - this._iconDrag.iconSize / 2),
            )
          }
          return Clutter.EVENT_STOP
        }

        if (t === Clutter.EventType.BUTTON_RELEASE) {
          let [x, y] = event.get_coords()
          let button = 1
          try {
            button = event.get_button()
          } catch (e) {
            button = 1
          }

          // 左键释放：如果没拖动，视为点击；如果拖动，执行移动窗口
          if (button === 1) {
            if (!this._iconDrag.dragging) {
              this._activateBestWindowOrApp(this._iconDrag.app, this._iconDrag.windows)
              this._cancelIconDrag()
              return Clutter.EVENT_STOP
            }

            let targetIndex = this._findWorkspaceIndexAtStageCoords(x, y)
            if (targetIndex !== null && targetIndex !== this._iconDrag.sourceWorkspace) {
              for (let w of this._iconDrag.windows || []) {
                try {
                  Main.moveWindowToMonitorAndWorkspace(
                    w,
                    w.get_monitor?.() ?? this.panel.monitor.index,
                    targetIndex,
                    true,
                  )
                } catch (e) {
                  // ignore
                }
              }
              try {
                let wm = Utils.DisplayWrapper.getWorkspaceManager()
                wm.get_workspace_by_index(targetIndex)?.activate(global.get_current_time())
              } catch (e) {
                // ignore
              }
            }
            this._cancelIconDrag()
            return Clutter.EVENT_STOP
          }

          this._cancelIconDrag()
          return Clutter.EVENT_PROPAGATE
        }

        return Clutter.EVENT_PROPAGATE
      })
    }

    _updateActiveState() {
      let workspaceManager = Utils.DisplayWrapper.getWorkspaceManager()
      let activeIndex = workspaceManager.get_active_workspace_index()

      for (let i = 0; i < this._workspaceItems.length; i++) {
        let item = this._workspaceItems[i]
        if (!item) continue

        let isActive = item._dtwIndex === activeIndex
        item.style_class = isActive
          ? 'workspace-preview-item-active'
          : 'workspace-preview-item'

        if (item._dtwNameLabel) this._applyNameLabelActiveStyle(item._dtwNameLabel, isActive)
      }
    }

    _updateIconFocusedState(iconButton) {
      // 更新单个图标的 focused 状态（不重建）
      if (!iconButton || !iconButton._dtwApp || !iconButton._dtwWorkspace) return

      try {
        let fw = global.display.focus_window
        let isFocused =
          fw &&
          fw.get_workspace?.() === iconButton._dtwWorkspace &&
          this._getWindowApp(fw) === iconButton._dtwApp

        if (isFocused) {
          iconButton.add_style_class_name('workspace-preview-app-icon-focused')
        } else {
          iconButton.remove_style_class_name('workspace-preview-app-icon-focused')
        }
      } catch (e) {
        // ignore
      }
    }

    _updateFocusedIcons() {
      // 更新所有图标的 focused 状态（不重建列表）
      for (let item of this._workspaceItems) {
        if (!item?._dtwOverlayLayer) continue
        try {
          let iconsBox = item._dtwOverlayLayer.get_children()?.[0]?.get_children()?.[0]
          if (!iconsBox) continue
          for (let child of iconsBox.get_children() || []) {
            if (child._dtwApp) {
              // 是图标按钮
              this._updateIconFocusedState(child)
            }
          }
        } catch (e) {
          // ignore
        }
      }
    }

    _updateWorkspaces() {
      this._cancelIconDrag()
      // 清除旧的预览项
      this._workspaceItems.forEach((item) => {
        if (item) item.destroy()
      })
      this._workspaceItems = []

      // 清除所有子元素
      let children = this.get_children()
      children.forEach((child) => this.remove_child(child))

      // 更新布局间距
      let layout = this.get_layout_manager()
      if (layout) {
        // 当图标层向下溢出时，额外增加条目间距，避免相互遮挡
        let base = SETTINGS.get_int('workspace-preview-spacing')
        let namePosition = SETTINGS.get_string('workspace-preview-name-position')
        let extra =
          namePosition == 'BOTTOM_RIGHT' || namePosition == 'BOTTOM_LEFT'
            ? Math.floor(APP_ICON_SIZE / 2)
            : 0
        layout.set_spacing(base + extra)
      }

      let workspaceManager = Utils.DisplayWrapper.getWorkspaceManager()
      let workspaceCount = workspaceManager.n_workspaces
      let activeWorkspace = workspaceManager.get_active_workspace()

      let previewWidth = SETTINGS.get_int('workspace-preview-width')
      // 列表项间距：只用于条目之间，不用于“撑满”高度
      let spacing = SETTINGS.get_int('workspace-preview-spacing')
      let namePosition = SETTINGS.get_string('workspace-preview-name-position')
      let isSidePanel =
        this.panel?.geom?.position == St.Side.LEFT ||
        this.panel?.geom?.position == St.Side.RIGHT

      // 预览高度：固定（根据宽度按工作区画面比例计算），不再按 workspace 数量“充满”整个区域
      let previewHeight = PREVIEW_HEIGHT
      try {
        let wa = Main.layoutManager.getWorkAreaForMonitor(this.panel.monitor.index)
        if (wa && wa.width > 0 && wa.height > 0) {
          previewHeight = Math.max(80, Math.round((previewWidth * wa.height) / wa.width))
        }
      } catch (e) {
        previewHeight = PREVIEW_HEIGHT
      }

      // 为每个工作区创建预览项（使用 GNOME Shell 原生 WorkspaceThumbnail）
      for (let i = 0; i < workspaceCount; i++) {
        let workspace = workspaceManager.get_workspace_by_index(i)
        let isActive = workspace == activeWorkspace

        let item = this._createWorkspaceItem(
          workspace,
          i,
          isActive,
          previewWidth,
          previewHeight,
          namePosition,
        )
        this.add_child(item)
        this._workspaceItems.push(item)
      }

      // 更新布局/可见性
      this._updateLayout()
      this._updateVisibility()

      // 重建后同步一次激活态（防止时序导致状态不一致）
      this._updateActiveState()

      // 记录当前 workarea key（用于去抖）
      this._lastWorkAreaKey = this._getWorkAreaKey()
    }

    _createWorkspaceItem(
      workspace,
      index,
      isActive,
      previewWidth,
      previewHeight,
      namePosition,
    ) {
      let container = new St.Widget({
        layout_manager: new Clutter.BoxLayout({
          orientation: Clutter.Orientation.VERTICAL,
          spacing: namePosition == 'BELOW' ? 4 : 0,
        }),
        style_class: isActive ? 'workspace-preview-item-active' : 'workspace-preview-item',
        // 空 workspace 没有窗口 clone 时，仍然要能点击切换
        reactive: true,
        track_hover: true,
      })
      container._dtwIndex = index
      container._dtwNameLabel = null
      container._dtwUpdateAppIcons = null  // 存储图标更新函数
      container._dtwPreviewArea = null
      container._dtwPreviewStack = null
      container._dtwThumbnail = null
      container._dtwBackgroundGroup = null
      container._dtwUpdateLabelPos = null

      // 预览容器：允许叠加层向外溢出
      let previewStack = new St.Widget({
        width: previewWidth,
        height: previewHeight,
        clip_to_allocation: false,
        layout_manager: new Clutter.BinLayout(),
        reactive: true,
        track_hover: true,
      })
      container._dtwPreviewStack = previewStack

      // 预览区域（只显示 workspace 内容，保持裁切）
      let previewArea = new St.Widget({
        width: previewWidth,
        height: previewHeight,
        style_class: 'workspace-preview-area',
        clip_to_allocation: true,
        layout_manager: new Clutter.BinLayout(),
        // 让预览区域本身也可点击（特别是空 workspace）
        reactive: true,
        track_hover: true,
      })
      container._dtwPreviewArea = previewArea

      // 背景层：显示桌面壁纸（即使没有窗口也不会是黑色）
      // 注意：这不是 workspace 内容的一部分，但视觉上符合“预览桌面背景”
      let bgManager = null
      // 用与 WorkspaceThumbnail 相同的 porthole（workArea）比例来缩放/居中背景。
      // 这里使用“cover”（铺满裁切）避免预览区出现留白。
      let wa = null
      let scale = 1
      try {
        wa = Main.layoutManager.getWorkAreaForMonitor(this.panel.monitor.index)
        if (wa && wa.width > 0 && wa.height > 0) {
          scale = Math.max(previewWidth / wa.width, previewHeight / wa.height)
        }
      } catch (e) {
        wa = null
        scale = 1
      }

      try {
        let backgroundGroup = new Meta.BackgroundGroup()
        if (wa) {
          backgroundGroup.set_size(wa.width, wa.height)
          backgroundGroup.set_scale(scale, scale)

          // 居中（允许负坐标，配合 clip 实现裁切）
          let contentW = wa.width * scale
          let contentH = wa.height * scale
          backgroundGroup.set_position(
            Math.floor((previewWidth - contentW) / 2),
            Math.floor((previewHeight - contentH) / 2),
          )
        } else {
          backgroundGroup.set_size(previewWidth, previewHeight)
        }
        previewArea.add_child(backgroundGroup)
        // 放在最底层
        previewArea.set_child_below_sibling(backgroundGroup, null)

        bgManager = new Background.BackgroundManager({
          monitorIndex: this.panel.monitor.index,
          container: backgroundGroup,
          vignette: false,
          controlPosition: false,
        })
        container._dtwBackgroundGroup = backgroundGroup
      } catch (e) {
        bgManager = null
      }

      try {
        // GNOME Shell 原生 WorkspaceThumbnail（overview 同款缩略图）
        let tmb = new WorkspaceThumbnail.WorkspaceThumbnail(
          workspace,
          this.panel.monitor.index,
        )

        // 按 porthole 比例缩放到 previewArea（cover：铺满裁切，避免留白）
        if (!wa) wa = Main.layoutManager.getWorkAreaForMonitor(this.panel.monitor.index)
        if (wa && wa.width > 0 && wa.height > 0) {
          scale = Math.max(previewWidth / wa.width, previewHeight / wa.height)
        } else {
          scale = 1
        }
        tmb.setScale(scale, scale)

        // 居中（允许负坐标，配合 clip 实现裁切）
        if (wa && wa.width > 0 && wa.height > 0) {
          let contentW = wa.width * scale
          let contentH = wa.height * scale
          tmb.set_position(
            Math.floor((previewWidth - contentW) / 2),
            Math.floor((previewHeight - contentH) / 2),
          )
        }

        previewArea.add_child(tmb)
        container._dtwThumbnail = tmb
      } catch (e) {
        // 如果创建失败，显示占位符
        let placeholder = new St.Label({
          text: _('Empty'),
          style: 'color: rgba(255,255,255,0.5); font-size: 14px;',
        })
        placeholder.set_position(previewWidth / 2 - 30, previewHeight / 2 - 10)
        previewArea.add_child(placeholder)
      }

      // 清理背景管理器，避免泄漏
      if (bgManager) {
        container.connect('destroy', () => {
          try {
            bgManager.destroy()
          } catch (e) {
            // ignore
          }
        })
      }

      // 先把预览区域加入容器，避免标签被排在预览上方
      previewStack.add_child(previewArea)
      container.add_child(previewStack)

      // 构建显示文本：序号 + 名称（若有）
      let displayText = `${index + 1}`
      try {
        let prefs = new Gio.Settings({ schema_id: WM_PREFS_SCHEMA })
        let names = prefs.get_strv('workspace-names')
        if (names && names.length > index && names[index]) {
          displayText = `${index + 1}. ${names[index]}`
        }
      } catch (e) {
        // ignore
      }

      container._dtwOverlayLayer = null
      container._dtwNameOverlayLayer = null
      if (namePosition == 'BOTTOM_RIGHT' || namePosition == 'BOTTOM_LEFT') {
        // 底部图标层：在预览层内部叠加一个透明层，用于放置图标列表
        // 这个层必须叠加在预览区域内部，且始终在最顶层（避免被窗口缩略图遮挡）
        let overlayLayer = new St.Widget({
          // 必须用 FixedLayout 才能让 set_position 生效（BinLayout 会忽略绝对坐标）
          layout_manager: new Clutter.FixedLayout(),
          // 允许拖拽窗口时穿透到缩略图
          reactive: false,
          track_hover: false,
          // 不设置 x_expand/y_expand，通过 set_size 精确控制尺寸
        })
        // 叠加层覆盖整个预览区域内部（从 0,0 开始，尺寸等于 previewArea）
        overlayLayer.set_position(0, 0)
        overlayLayer.set_size(previewWidth, previewHeight)
        previewStack.add_child(overlayLayer)
        // 确保 overlayLayer 始终在最顶层（避免被 WorkspaceThumbnail 的窗口克隆遮挡）
        previewStack.set_child_above_sibling(overlayLayer, null)

        // 徽章：仅显示 app 图标列表
        let badge = new St.BoxLayout({
          style_class: 'workspace-preview-badge',
          reactive: false,
          track_hover: false,
          can_focus: false,
        })
        let iconsBox = new St.BoxLayout({
          style_class: 'workspace-preview-app-icons',
          reactive: false,
          track_hover: false,
          can_focus: false,
        })
        badge.add_child(iconsBox)

        overlayLayer.add_child(badge)
        
        // 记录图标尺寸，用于固定计算（避免图标加入后 preferred_size 变化导致布局错乱）
        let badgeIconSize = APP_ICON_SIZE

        // 顶部序号层：单独叠加一层，仅显示序号/名称
        let nameOverlayLayer = new St.Widget({
          layout_manager: new Clutter.FixedLayout(),
          // 允许拖拽窗口时穿透到缩略图
          reactive: false,
          track_hover: false,
        })
        nameOverlayLayer.set_position(0, 0)
        nameOverlayLayer.set_size(previewWidth, previewHeight)
        previewStack.add_child(nameOverlayLayer)
        previewStack.set_child_above_sibling(nameOverlayLayer, null)

        let nameLabel = new St.Label({
          text: displayText,
          style_class: 'workspace-preview-name',
          style: '',
        })
        this._applyNameLabelActiveStyle(nameLabel, isActive)
        nameOverlayLayer.add_child(nameLabel)
        container._dtwNameLabel = nameLabel
        container._dtwOverlayLayer = overlayLayer
        container._dtwNameOverlayLayer = nameOverlayLayer

        // 根据 previewArea 实际分配尺寸，把图标与序号分别定位
        let margin = 10
        let updateLabelPos = () => {
          // 确保叠加层始终在最顶层（防止 WorkspaceThumbnail 动态添加的窗口克隆遮挡）
          previewStack.set_child_above_sibling(container._dtwOverlayLayer, null)
          previewStack.set_child_above_sibling(container._dtwNameOverlayLayer, null)

          // 获取 previewArea 的实际分配尺寸（用于计算 badge 在内部的位置）
          let box = previewArea.get_allocation_box()
          let w = box.x2 - box.x1
          let h = box.y2 - box.y1

          // 同步 overlayLayer 的尺寸（确保它覆盖整个 previewArea 内部）
          container._dtwOverlayLayer.set_size(w, h)
          container._dtwNameOverlayLayer.set_size(w, h)

          // 计算 badge 的尺寸（用固定计算，避免图标加入后 preferred_size 变化）
          // 图标数量（最多 APP_ICON_MAX 个）
          let iconCount = Math.min(iconsBox.get_children().length, APP_ICON_MAX)
          // 图标间距（从 CSS 读取或默认 4px）
          let iconSpacing = 4
          // badge 宽度 = 图标数量 × 图标尺寸 + (数量-1) × 间距
          let natW = iconCount * badgeIconSize + Math.max(0, iconCount - 1) * iconSpacing
          // badge 高度 = 图标尺寸
          let natH = badgeIconSize

          // 计算 badge 在 overlayLayer 内部的坐标（相对于 overlayLayer 的 0,0）
          // x: 左下角 = margin，右下角 = w - natW - margin
          let x =
            namePosition == 'BOTTOM_LEFT'
              ? margin
              : Math.max(margin, w - natW - margin)
          // y: 向下再降半个图标高度（总共溢出 1 个图标高度），并配合列表间距避免遮挡
          let y = Math.max(margin, h - natH - margin + Math.floor(natH))

          badge.set_position(x, y)

          // 顶部序号：固定在左上角
          let [, , nameW, nameH] = nameLabel.get_preferred_size()
          let nameX = margin
          let nameY = margin
          nameLabel.set_position(nameX, nameY)
        }
        container._dtwUpdateLabelPos = updateLabelPos

        // 图标刷新（只更新这一项，不重建整个预览列表）
        const tracker = Shell.WindowTracker.get_default()
        const updateAppIcons = () => {
          let windows = this._listWorkspaceWindows(workspace)

          // 图标大小固定，避免选中时变化
          let iconSize = APP_ICON_SIZE
          // 同步更新 badge 图标尺寸（用于固定计算）
          badgeIconSize = iconSize

          // 去重：同一应用只显示一次
          let apps = this._getUniqueAppsFromWindows(windows)

          const total = apps.length
          const shown = apps.slice(0, APP_ICON_MAX)
          const hidden = apps.slice(APP_ICON_MAX)

          // 内容无变化则不重建（减少抖动）
          const ids = shown
            .map((a) => {
              try {
                return a.get_id()
              } catch (e) {
                return a.get_name?.() || String(a)
              }
            })
            .join('|')
          const sig = `${ids}__${hidden.length}`
          if (container._dtwIconSig === sig) {
            updateLabelPos()
            return
          }
          container._dtwIconSig = sig

          // 现在才清空（避免无谓 destroy/recreate）
          iconsBox.get_children().forEach((c) => c.destroy())

          for (let app of shown) {
            let iconButton = this._createPreviewAppIconButton({
              app,
              workspace,
              iconSize,
              tracker,
            })
            if (iconButton) iconsBox.add_child(iconButton)
          }

          if (total > APP_ICON_MAX) {
            let moreBtn = new St.Button({
              reactive: true,
              track_hover: true,
              can_focus: false,
              style_class: 'workspace-preview-app-more-button',
              child: new St.Label({
                text: `+${total - APP_ICON_MAX}`,
                style_class: 'workspace-preview-app-more',
              }),
            })
            moreBtn.connect('clicked', () => {
              // 懒创建 menu
              if (!moreBtn._dtwMenu) {
                let menu = new PopupMenu.PopupMenu(
                  moreBtn,
                  0.5,
                  this.panel.geom.position,
                )
                menu.blockSourceEvents = true
                Main.uiGroup.add_child(menu.actor)
                this._iconMenuManager.addMenu(menu)
                for (let app of hidden) {
                  let label = null
                  try {
                    label = app.get_name()
                  } catch (e) {
                    label = String(app)
                  }
                  menu.addAction(label, () => {
                    AppIcons.activateAllWindows(app, this.panel.monitor)
                  })
                }
                moreBtn._dtwMenu = menu
              }
              moreBtn._dtwMenu.open(BoxPointer.PopupAnimation.FULL)
              this._iconMenuManager.ignoreRelease()
            })
            iconsBox.add_child(moreBtn)
          }

          // 图标尺寸变化时，重新计算 badge 位置
          updateLabelPos()
        }

        const queueUpdateAppIcons = () => {
          this._timeoutsHandler.add([
            `ws-app-icons-${index}`,
            80,
            () => updateAppIcons(),
          ])
        }

        // 存储更新函数到container，以便在激活状态变化时调用
        container._dtwUpdateAppIcons = queueUpdateAppIcons

        // 初次刷新一次
        queueUpdateAppIcons()

        // workspace 内窗口变动时，仅刷新图标条
        try {
          // connectObject 会在 container destroy 时自动断开
          workspace.connectObject(
            'window-added',
            queueUpdateAppIcons,
            'window-removed',
            queueUpdateAppIcons,
            container,
          )
        } catch (e) {
          // ignore
        }

        // 初次定位 + 尺寸变化时重新定位
        updateLabelPos()
        let allocId = previewArea.connect('notify::allocation', updateLabelPos)
        container.connect('destroy', () => {
          try {
            previewArea.disconnect(allocId)
          } catch (e) {
            // ignore
          }
        })
      } else if (namePosition == 'BELOW') {
        // 只在选择 BELOW 时，才单独占一行放在预览下方
        let nameLabel = new St.Label({
          text: displayText,
          style_class: 'workspace-preview-name',
          style: '',
        })
        this._applyNameLabelActiveStyle(nameLabel, isActive)
        container._dtwNameLabel = nameLabel
        nameLabel.set_height(NAME_HEIGHT)
        container.add_child(nameLabel)
      }

      // 拖放目标：把窗口从一个 workspace 预览拖到另一个
      // 说明：WorkspaceThumbnail 里的 WindowClone 本身就是可拖拽源（DND.makeDraggable）。
      // 我们在这里实现 drop target 的 handleDragOver/acceptDrop，让它能落到预览上。
      // 拖放目标：挂在 previewStack/previewArea/叠加层，确保始终可接收拖放
      const dropDelegate = {
        handleDragOver: (source, _actor, _x, _y, _time) => {
          // 只处理窗口缩略图（WindowClone）拖拽
          if (source?.metaWindow) return DND.DragMotionResult.MOVE_DROP
          return DND.DragMotionResult.CONTINUE
        },
        acceptDrop: (source, _actor, _x, _y, time) => {
          if (!source?.metaWindow) return false

          try {
            this._dragInProgress = false

            // 窗口拖拽：移动单个窗口（优先保持原 monitor）
            Main.moveWindowToMonitorAndWorkspace(
              source.metaWindow,
              source.metaWindow.get_monitor?.() ?? this.panel.monitor.index,
              workspace.index(),
              true,
            )
            
            // 可选：拖放成功后切换到目标 workspace（符合直觉）
            workspace.activate(time ?? global.get_current_time())
            return true
          } catch (e) {
            return false
          }
        },
      }
      const dragOverDelegate = {
        handleDragOver: (source, actor, x, y, time) => {
          this._dragInProgress = true
          return dropDelegate.handleDragOver(source, actor, x, y, time)
        },
        acceptDrop: dropDelegate.acceptDrop,
      }
      previewStack._delegate = dragOverDelegate
      previewArea._delegate = dragOverDelegate
      if (container._dtwOverlayLayer) container._dtwOverlayLayer._delegate = dragOverDelegate
      if (container._dtwNameOverlayLayer)
        container._dtwNameOverlayLayer._delegate = dragOverDelegate

      // 右键处理：切换 intellihide 状态（在 button-press 上处理，避免被 panel 拦截）
      // 在多个层上连接右键事件，确保能捕获到（previewStack 和 previewArea 已经有 reactive: true）
      previewStack.connect('button-press-event', (actor, event) =>
        this._handleRightClick(actor, event),
      )
      previewArea.connect('button-press-event', (actor, event) =>
        this._handleRightClick(actor, event),
      )

      // 点击切换工作区：不要在 button-press 上 EVENT_STOP（会阻断拖拽）
      // 改为 button-release，并且不拦截 press，让拖拽手势正常启动。
      let onClickRelease = (_actor, event) => {
        try {
          if (event.get_button && event.get_button() !== 1) return Clutter.EVENT_PROPAGATE
        } catch (e) {
          // ignore
        }
        if (this._dragInProgress) {
          this._dragInProgress = false
          return Clutter.EVENT_PROPAGATE
        }
        workspace.activate(global.get_current_time())
        return Clutter.EVENT_STOP
      }
      container.connect('button-release-event', onClickRelease)
      previewArea.connect('button-release-event', onClickRelease)

      return container
    }

    destroy() {
      this._cancelIconDrag()
      this._workspaceItems.forEach((item) => item.destroy())
      this._workspaceItems = []

      // 断开扩展状态监听
      if (this._extensionStateChangedId) {
        try {
          this._extensionManager?.disconnect(this._extensionStateChangedId)
        } catch (e) {
          // ignore
        }
        this._extensionStateChangedId = null
      }

      this._signalsHandler.destroy()
      this._timeoutsHandler.destroy()
      super.destroy()
    }
  },
)
