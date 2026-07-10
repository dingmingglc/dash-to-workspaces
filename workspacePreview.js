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

import {
  APP_ICON_MAX,
  DEFAULT_APP_ICON_SIZE,
  MIN_PREVIEW_HEIGHT,
  NAME_HEIGHT,
  PREVIEW_HEIGHT,
  SHORTCUT_SLOTS,
  WM_PREFS_SCHEMA,
} from './workspacePreview/constants.js'
import * as Utils from './utils.js'
import * as AppIcons from './appIcons.js'
import { SETTINGS } from './extension.js'
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js'

export const WorkspacePreviewView = GObject.registerClass(
  {},
  class WorkspacePreviewView extends St.Widget {
    _init(panel) {
      super._init({
        layout_manager: new Clutter.BoxLayout({
          orientation: Clutter.Orientation.VERTICAL,
          // 根容器不做 item spacing：workspace 列表的 spacing 由 _wsList 控制；
          // 这样底部快捷栏才能稳定固定在底部且不参与 workspace 数量计算。
          spacing: 0,
        }),
        style_class: 'workspace-preview-view',
        reactive: true,
        // 防止 workspace/图标溢出到面板外（即便计算时序还没更新到位，也不允许画到屏幕外）
        clip_to_allocation: true,
      })

      this.panel = panel
      // workspace 列表容器（可伸缩，底部快捷栏不在此容器内）
      this._wsList = new St.Widget({
        layout_manager: new Clutter.BoxLayout({
          orientation: Clutter.Orientation.VERTICAL,
          spacing: SETTINGS.get_int('workspace-preview-spacing'),
        }),
        reactive: false,
        clip_to_allocation: true,
        x_expand: true,
        y_expand: true,
      })
      this.add_child(this._wsList)
      this._workspaceItems = []
      this._signalsHandler = new Utils.GlobalSignalsHandler()
      this._timeoutsHandler = new Utils.TimeoutsHandler()
      this._iconMenuManager = new PopupMenu.PopupMenuManager(this)
      this._dragInProgress = false
      this._iconDrag = null
      this._dtwDestroyed = false
      this._lastWorkAreaKey = null
      this._didInitialWindowRefresh = false
      this._dropHighlightItem = null
      // 预览区底部快捷栏（固定 5 个槽位）
      this._shortcutsBar = null
      this._shortcutsButtons = []
      // window->app 缓存（WeakMap：窗口销毁时自动清理）
      this._windowAppCache = new WeakMap()
      this._tracker = Shell.WindowTracker.get_default()
      // 每个 workspace 的图标稳定排序（避免激活后“最近使用”导致图标互换）
      // workspaceIndex -> Map(appId -> orderNumber)
      this._workspaceAppOrder = new Map()
      this._workspaceAppOrderNext = new Map()
      // focused icon 追踪：只更新“上一个 + 当前”两个按钮
      this._lastFocusedIcon = null // { wsIndex, appId }
      // 防止回退重建过程中被重复触发
      this._dtwRebuildInProgress = false
      // workspace 名称设置（复用同一个 Gio.Settings，避免每次创建）
      this._wmPrefs = null
      try {
        this._wmPrefs = new Gio.Settings({ schema_id: WM_PREFS_SCHEMA })
      } catch (e) {
        this._wmPrefs = null
      }

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
      // 用 captured-event：WorkspaceThumbnail 的 WindowClone 会吃掉 button-press，
      // 冒泡阶段经常收不到，表现为“有时右键不灵”。
      this._signalsHandler.add([
        this,
        'captured-event',
        (actor, event) => {
          try {
            if (event.type() !== Clutter.EventType.BUTTON_PRESS)
              return Clutter.EVENT_PROPAGATE
            return this._handleRightClick(actor, event)
          } catch (e) {
            return Clutter.EVENT_PROPAGATE
          }
        },
      ])

      // 预览视图自身 allocation 变化时，只做几何更新（避免每个 item 都监听 allocation）
      this._signalsHandler.add([
        this,
        'notify::allocation',
        () => {
          this._timeoutsHandler.add([
            'ws-preview-self-alloc-geom',
            50,
            () => {
              this._updateShortcutsBar()
              this._updateWorkspacesGeometry()
            },
          ])
        },
      ])

      // 面板总宽度变化时重算快捷栏槽位宽度（BOTH 模式横跨预览 + dash）
      this._signalsHandler.add([
        this.panel,
        'notify::allocation',
        () => {
          this._timeoutsHandler.add([
            'ws-preview-panel-alloc-shortcuts',
            50,
            () => this._updateShortcutsBar(),
          ])
        },
      ])

      // workspace 列表高度变化时也要重算（新增 workspace / 样式变化会影响可用高度）
      this._signalsHandler.add([
        this._wsList,
        'notify::allocation',
        () => {
          this._timeoutsHandler.add([
            'ws-preview-list-alloc-geom',
            50,
            () => this._updateWorkspacesGeometry(),
          ])
        },
      ])

      // 监听设置变化
      this._connectSettingsSignals()

      // 监听工作区变化
      this._connectSignals()

      // 延迟更新布局和可见性，确保面板已经布局完成
      GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        this._updateLayout()
        this._updateVisibility()
        // 快捷栏先初始化出来，保证底部始终预留一块图标高的区域
        this._ensureShortcutsBar()
        // 启动更顺滑：把 WorkspaceThumbnail/背景等重建推迟到更低优先级的 idle
        // 避免启用扩展瞬间同步创建所有 workspace 缩略图导致掉帧。
        GLib.idle_add(GLib.PRIORITY_LOW, () => {
          if (!this._workspaceItems?.length) this._updateWorkspaces()
          return GLib.SOURCE_REMOVE
        })
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
          () => {
            this._updateVisibility()
            this._updateShortcutsBar()
          },
        ],
        [
          SETTINGS,
          'changed::workspace-preview-width',
          () => {
            // 仅几何变化：避免重建缩略图/背景导致卡顿
            this._updateLayout()
            this._updateShortcutsBar()
            if (this._workspaceItems?.length) this._updateWorkspacesGeometry()
            else this._updateWorkspaces()
          },
        ],
        [
          SETTINGS,
          'changed::workspace-preview-spacing',
          () => {
            // 只影响条目间距：不必重建
            this._updateListSpacingForIconSize()
          },
        ],
        [
          SETTINGS,
          'changed::workspace-preview-name-position',
          () => this._updateWorkspaces(),
        ],
        [
          SETTINGS,
          'changed::workspace-preview-app-icons-stable-order',
          () => {
            // 切换排序策略时，清空稳定排序缓存并刷新当前图标
            this._workspaceAppOrder?.clear?.()
            this._workspaceAppOrderNext?.clear?.()
            for (let item of this._workspaceItems || []) {
              try {
                item?._dtwUpdateAppIcons?.()
              } catch (e) {
                // ignore
              }
            }
          },
        ],
        [
          SETTINGS,
          'changed::workspace-preview-app-icon-size',
          () => {
            // 图标尺寸变化时需要强制重建（签名需要包含 iconSize）
            this._updateListSpacingForIconSize()
            this._updateShortcutsBar()
            for (let item of this._workspaceItems || []) {
              try {
                item._dtwIconSig = null
                item?._dtwUpdateAppIcons?.()
              } catch (e) {
                // ignore
              }
            }
          },
        ],
        [
          SETTINGS,
          'changed::workspace-preview-shortcut-apps',
          () => this._updateShortcutsBar(),
        ],
      )
    }

    _isSidePanel() {
      const pos = this.panel?.geom?.position
      return pos === St.Side.LEFT || pos === St.Side.RIGHT
    }

    /** 预览列/行主尺寸（侧栏=宽，上下栏=高）。 */
    _getPreviewMainSize() {
      try {
        const box = this.get_allocation_box()
        if (this._isSidePanel()) {
          const w = box.x2 - box.x1
          if (w > 0) return w
        } else {
          const h = box.y2 - box.y1
          if (h > 0) return h
        }
      } catch (e) {
        // ignore
      }
      try {
        return SETTINGS.get_int('workspace-preview-width')
      } catch (e) {
        return 200
      }
    }

    /** 预览列实际宽度（优先用 allocation，避免与设置值不一致导致两侧留白）。 */
    _getPreviewColumnWidth() {
      if (!this._isSidePanel()) {
        // 上/下：每个预览项宽度由高度按 workarea 比例推算
        return this._computePreviewWidth(
          this._getPreviewMainSize(),
          this._workspaceItems?.length || 1,
          SETTINGS.get_string('workspace-preview-name-position'),
        )
      }
      return this._getPreviewMainSize()
    }

    _getItemPreviewWidth(item) {
      const border = 4
      try {
        const box = item.get_allocation_box()
        const w = box.x2 - box.x1
        if (w > border) return w - border
      } catch (e) {
        // ignore
      }
      return this._getPreviewColumnWidth()
    }

    _getItemPreviewHeight(item, fallback) {
      const border = 4
      try {
        const box = item.get_allocation_box()
        const h = box.y2 - box.y1
        if (h > border) return h - border
      } catch (e) {
        // ignore
      }
      return fallback
    }

    /** intellihide 关闭时面板通过 struts 固定占位；开启时 workarea 始终为全屏。 */
    _panelReservesStruts() {
      return !this.panel?.intellihide?.enabled
    }

    /**
     * 工作区缩略图 porthole：与 shell workarea 对齐；仅在面板固定占位时再扣除面板条带。
     */
    _getWorkAreaForPreview() {
      const mon = this.panel?.monitor
      const geom = this.panel?.geom
      if (!mon || !geom) return null

      let wa = null
      try {
        wa = Main.layoutManager.getWorkAreaForMonitor(mon.index)
      } catch (e) {
        wa = null
      }

      const fallback = {
        x: mon.x,
        y: mon.y,
        width: mon.width,
        height: mon.height,
      }
      if (!wa) return fallback

      // 自动隐藏：桌面区域不扣除面板（面板浮在上面，不占 struts）
      if (!this._panelReservesStruts()) return wa

      const panelSpan = Math.max(0, geom.outerSize || geom.w || 0)
      if (!panelSpan) return wa

      const rect = {
        x: wa.x,
        y: wa.y,
        width: wa.width,
        height: wa.height,
      }
      const pos = geom.position

      // 固定面板：若 workarea 尚未反映整条面板宽度，手动扣除
      if (pos === St.Side.RIGHT) {
        const desktopW = Math.max(1, mon.width - panelSpan)
        rect.x = mon.x
        rect.width = Math.min(rect.width, desktopW)
      } else if (pos === St.Side.LEFT) {
        const desktopW = Math.max(1, mon.width - panelSpan)
        const desktopX = mon.x + panelSpan
        if (rect.x < desktopX) rect.x = desktopX
        rect.width = Math.min(rect.width, desktopW)
      } else if (pos === St.Side.TOP) {
        const desktopH = Math.max(1, mon.height - panelSpan)
        const desktopY = mon.y + panelSpan
        if (rect.y < desktopY) rect.y = desktopY
        rect.height = Math.min(rect.height, desktopH)
      } else if (pos === St.Side.BOTTOM) {
        const desktopH = Math.max(1, mon.height - panelSpan)
        rect.height = Math.min(rect.height, desktopH)
      }

      return rect
    }

    _applyThumbnailPorthole(item, wa) {
      if (!item?._dtwThumbnail || !wa) return
      try {
        item._dtwThumbnail.setPorthole(wa.x, wa.y, wa.width, wa.height)
      } catch (e) {
        // ignore
      }
    }

    _getPreviewAppIconSize() {
      // 预览区下方应用图标大小（允许设置覆盖）
      let iconSize = DEFAULT_APP_ICON_SIZE
      try {
        iconSize = SETTINGS.get_int('workspace-preview-app-icon-size')
      } catch (e) {
        iconSize = DEFAULT_APP_ICON_SIZE
      }
      return Math.max(16, Math.min(96, iconSize))
    }

    /** 底部快捷栏横跨宽度：BOTH 模式下占满整条面板（预览 + dash）。 */
    _getShortcutBarSpanWidth() {
      const displayMode = SETTINGS.get_string('workspace-preview-display-mode')
      const showPanel = displayMode === 'PANEL' || displayMode === 'BOTH'
      if (showPanel && this.panel) {
        try {
          const box = this.panel.get_allocation_box()
          const w = box.x2 - box.x1
          if (w > 0) return w
        } catch (e) {
          // ignore
        }
        try {
          const previewW = SETTINGS.get_int('workspace-preview-width')
          const taskW = this.panel.geom?.w ?? 0
          if (previewW > 0 && taskW > 0) return previewW + taskW
        } catch (e) {
          // ignore
        }
      }
      return this._getPreviewColumnWidth()
    }

    /** 快捷栏：侧栏横跨底部；上/下栏竖排在最右侧。 */
    _getShortcutBarLayout() {
      const preferred = this._getPreviewAppIconSize()
      const slotCount = SHORTCUT_SLOTS
      const side = this._isSidePanel()

      if (side) {
        const colWidth = this._getShortcutBarSpanWidth()
        const slotWidth = Math.max(20, Math.floor(colWidth / slotCount))
        const chrome = Math.max(2, Math.min(6, Math.floor(slotWidth * 0.1)))
        const iconSize = Math.max(16, Math.min(preferred, slotWidth - chrome))
        return {
          vertical: false,
          colWidth,
          slotWidth,
          iconSize,
          chrome,
          barHeight: iconSize + chrome + 4,
          barWidth: colWidth,
        }
      }

      // 上/下：快捷栏竖排，宽度由图标决定，高度填满预览行
      let barHeight = this._getPreviewMainSize()
      try {
        const box = this.panel?.get_allocation_box?.()
        if (box) {
          const h = box.y2 - box.y1
          if (h > 0) barHeight = h
        }
      } catch (e) {
        // ignore
      }
      const slotHeight = Math.max(20, Math.floor(barHeight / slotCount))
      const chrome = Math.max(2, Math.min(6, Math.floor(slotHeight * 0.1)))
      const iconSize = Math.max(16, Math.min(preferred, slotHeight - chrome))
      const barWidth = iconSize + chrome + 4
      return {
        vertical: true,
        colWidth: barWidth,
        slotWidth: barWidth,
        iconSize,
        chrome,
        barHeight,
        barWidth,
      }
    }

    _updateListSpacingForIconSize() {
      // 图标层向下溢出时，条目间距需要随图标尺寸调整，否则大图标会挤/遮挡
      let layout = this._wsList?.get_layout_manager?.()
      if (!layout) return

      let base = 0
      let namePosition = 'BOTTOM_RIGHT'
      try {
        base = SETTINGS.get_int('workspace-preview-spacing')
        namePosition = SETTINGS.get_string('workspace-preview-name-position')
      } catch (e) {
        base = 0
        namePosition = 'BOTTOM_RIGHT'
      }

      let extra = 0
      // 只要启用了“预览内叠加层（包含底部 app icons）”，就需要为“向下溢出”的图标行预留额外间距。
      // 说明：图标按钮本身在 CSS 里有 padding(2px) + focused border(1px)，
      // 因此实际占用高度略大于 iconSize；这里把这些额外像素也计入，避免用户把图标调大后间距不跟着变。
      if (namePosition !== 'BELOW') {
        const iconSize = this._getPreviewAppIconSize()
        const chromeOverheadPx = 6 // 约等于 2*padding(2px) + 2*border(1px)
        extra = Math.ceil((iconSize + chromeOverheadPx) / 2)
      }

      layout.set_spacing(base + extra)

      // 最后一个 workspace 的图标也会向下溢出，需要给列表底部预留空间，
      // 否则会被“底部快捷栏”挤住/覆盖。侧栏用 padding-bottom；上/下用 padding-right。
      try {
        if (this._isSidePanel())
          this._wsList.set_style(`padding-bottom: ${extra}px;`)
        else this._wsList.set_style(`padding-right: ${extra}px;`)
      } catch (e) {
        // ignore
      }
    }

    getShortcutsBarHeight() {
      return this._getShortcutBarLayout().barHeight
    }

    getShortcutsBarWidth() {
      return this._getShortcutBarLayout().barWidth
    }

    isShortcutsBarVertical() {
      return !this._isSidePanel()
    }

    _allocateShortcutsBar(box) {
      if (!this._shortcutsBar) return
      this._shortcutsBar.visible = true
      this._shortcutsBar.allocate(box)
    }

    _getWorkspaceListAvailableHeightPx() {
      // 可用于 workspace items 的高度（快捷栏由 Panel 单独分配，不在此区域内）
      let totalH = 0
      try {
        const box = this.get_allocation_box()
        totalH = (box.y2 - box.y1) || 0
      } catch (e) {
        totalH = 0
      }

      // 如果还没 allocation，尝试用 monitor 和 panel 的几何信息估算（避免早期阶段算出 0）
      if (!totalH && this.panel?.monitor && this.panel?.geom) {
        if (this._isSidePanel()) {
          // 左/右面板：预览区域高度应该等于屏幕高度减去顶部避让
          let topInset = 0
          try {
            if (
              SETTINGS.get_boolean('workspace-preview-avoid-dash-to-panel') &&
              global.dashToPanel?.panels?.length &&
              this.panel._getExternalTopInsetPx
            ) {
              topInset = this.panel._getExternalTopInsetPx()
            }
          } catch (e) {
            topInset = 0
          }
          totalH = Math.max(0, this.panel.monitor.height - topInset)
        } else {
          // 上/下面板：预览区域高度 = 预览厚度（固定值）
          try {
            totalH = SETTINGS.get_int('workspace-preview-width') || 0
          } catch (e) {
            totalH = 0
          }
        }
      }

      return Math.max(0, totalH)
    }

    _getWorkspaceListAvailableWidthPx() {
      let totalW = 0
      try {
        const box = this.get_allocation_box()
        totalW = (box.x2 - box.x1) || 0
      } catch (e) {
        totalW = 0
      }

      if (!totalW && this.panel?.monitor && this.panel?.geom) {
        if (this._isSidePanel()) {
          try {
            totalW = SETTINGS.get_int('workspace-preview-width') || 0
          } catch (e) {
            totalW = 0
          }
        } else {
          totalW = Math.max(0, this.panel.monitor.width)
        }
      }

      return Math.max(0, totalW)
    }

    _computePreviewHeight(previewWidth, workspaceCount, namePosition) {
      // 先按 workarea 比例算“理想高度”，再按可用高度缩小以塞下全部 workspace。
      let ideal = PREVIEW_HEIGHT
      try {
        const wa = this._getWorkAreaForPreview()
        if (wa && wa.width > 0 && wa.height > 0) {
          ideal = Math.round((previewWidth * wa.height) / wa.width)
        }
      } catch (e) {
        // ignore
      }

      // 上/下：高度由预览行厚度决定，不再按数量纵向压缩
      if (!this._isSidePanel()) {
        const rowH = this._getPreviewMainSize()
        return Math.max(MIN_PREVIEW_HEIGHT, rowH || ideal)
      }

      const avail = this._getWorkspaceListAvailableHeightPx()
      const n = Math.max(1, workspaceCount || 1)

      // 列表 spacing（workspace items 之间）
      let spacing = 0
      try {
        spacing = this._wsList?.get_layout_manager?.()?.get_spacing?.() ?? 0
      } catch (e) {
        spacing = 0
      }

      // namePosition == BELOW 时，label 会占额外高度（约 NAME_HEIGHT + 4）
      const belowExtra = namePosition === 'BELOW' ? NAME_HEIGHT + 4 : 0
      // workspace item 自身的 “chrome” 高度（CSS border 等）。当前样式是 2px border，上下共约 4px。
      const itemChrome = 4
      // 底部图标溢出高度：最后一个 workspace 也需要预留（通过 _wsList 的 padding-bottom 实现）
      const iconOverflowPx =
        namePosition === 'BELOW'
          ? 0
          : Math.ceil((this._getPreviewAppIconSize() + 6) / 2)

      // _wsList 的 padding-bottom 也需要计入（它会影响列表的实际占用高度）
      const listPaddingBottom = iconOverflowPx

      const fixed =
        (n - 1) * spacing + n * (belowExtra + itemChrome) + listPaddingBottom

      // 如果还没拿到真实高度（avail≈0），不要硬夹到最小，先用理想高度显示，
      // 等 allocation 稳定后 notify::allocation 会触发 _updateWorkspacesGeometry 重新计算。
      if (!avail || avail < MIN_PREVIEW_HEIGHT * n) {
        return Math.max(MIN_PREVIEW_HEIGHT, ideal)
      }

      // 只有当“理想高度排布后真的放不下”时才缩小
      const needTotal =
        n * (ideal + belowExtra + itemChrome) +
        (n - 1) * spacing +
        listPaddingBottom
      if (needTotal <= avail) {
        return Math.max(MIN_PREVIEW_HEIGHT, ideal)
      }

      let per = Math.floor((avail - fixed) / n)
      if (!Number.isFinite(per)) per = ideal

      // 缩小时允许缩到很小以保证塞得下（用户要求）
      return Math.max(MIN_PREVIEW_HEIGHT, Math.min(ideal, per))
    }

    _computePreviewWidth(previewHeight, workspaceCount, namePosition) {
      const ideal = this._getIdealPreviewItemWidth(previewHeight)

      if (this._isSidePanel()) return ideal

      // 动态长度：按内容理想宽度，不向可用宽度拉伸/压缩
      if (this.panel?.geom?.dynamic) return ideal

      const avail = this._getWorkspaceListAvailableWidthPx()
      const n = Math.max(1, workspaceCount || 1)

      let spacing = 0
      try {
        spacing = this._wsList?.get_layout_manager?.()?.get_spacing?.() ?? 0
      } catch (e) {
        spacing = 0
      }

      const itemChrome = 4
      const iconOverflowPx =
        namePosition === 'BELOW'
          ? 0
          : Math.ceil((this._getPreviewAppIconSize() + 6) / 2)
      const listPaddingEnd = iconOverflowPx
      const fixed = (n - 1) * spacing + n * itemChrome + listPaddingEnd

      if (!avail || avail < MIN_PREVIEW_HEIGHT * n) {
        return ideal
      }

      const needTotal = n * (ideal + itemChrome) + (n - 1) * spacing + listPaddingEnd
      if (needTotal <= avail) {
        return ideal
      }

      let per = Math.floor((avail - fixed) / n)
      if (!Number.isFinite(per)) per = ideal
      return Math.max(MIN_PREVIEW_HEIGHT, Math.min(ideal, per))
    }

    _getIdealPreviewItemWidth(previewHeight) {
      let ideal = previewHeight
      try {
        const wa = this._getWorkAreaForPreview()
        if (wa && wa.width > 0 && wa.height > 0) {
          ideal = Math.round((previewHeight * wa.width) / wa.height)
        }
      } catch (e) {
        // ignore
      }
      return Math.max(MIN_PREVIEW_HEIGHT, ideal)
    }

    _getIdealPreviewItemHeight(previewWidth) {
      let ideal = PREVIEW_HEIGHT
      try {
        const wa = this._getWorkAreaForPreview()
        if (wa && wa.width > 0 && wa.height > 0) {
          ideal = Math.round((previewWidth * wa.height) / wa.width)
        }
      } catch (e) {
        // ignore
      }
      return Math.max(MIN_PREVIEW_HEIGHT, ideal)
    }

    /**
     * 动态面板长度用：预览 + 快捷栏的自然尺寸（沿面板可变轴）。
     * 上/下 → 返回宽度；左/右 → 返回高度。
     */
    getNaturalContentLength() {
      const n = Math.max(1, this._workspaceItems?.length || 1)
      let spacing = 0
      try {
        spacing =
          this._wsList?.get_layout_manager?.()?.get_spacing?.() ??
          SETTINGS.get_int('workspace-preview-spacing')
      } catch (e) {
        spacing = 0
      }
      const itemChrome = 4

      if (this._isSidePanel()) {
        const previewWidth = this._getPreviewMainSize()
        const itemH = this._getIdealPreviewItemHeight(previewWidth)
        const namePosition =
          SETTINGS.get_string('workspace-preview-name-position') || 'BOTTOM_RIGHT'
        const belowExtra = namePosition === 'BELOW' ? NAME_HEIGHT + 4 : 0
        const iconOverflowPx =
          namePosition === 'BELOW'
            ? 0
            : Math.ceil((this._getPreviewAppIconSize() + 6) / 2)
        const listH =
          n * (itemH + belowExtra + itemChrome) +
          (n - 1) * spacing +
          iconOverflowPx
        const barH = this.getShortcutsBarHeight() || 0
        return Math.max(1, listH + barH)
      }

      const previewHeight = this._getPreviewMainSize()
      const itemW = this._getIdealPreviewItemWidth(previewHeight)
      const namePosition =
        SETTINGS.get_string('workspace-preview-name-position') || 'BOTTOM_RIGHT'
      const iconOverflowPx =
        namePosition === 'BELOW'
          ? 0
          : Math.ceil((this._getPreviewAppIconSize() + 6) / 2)
      const listW =
        n * (itemW + itemChrome) + (n - 1) * spacing + iconOverflowPx
      const barW = this.getShortcutsBarWidth() || 0
      return Math.max(1, listW + barW)
    }

    /**
     * 等比缩放布局：contain；固定占位时贴面板边缘对齐，自动隐藏时居中。
     */
    _getPreviewScaleLayout(previewWidth, previewHeight, wa) {
      const baseW = wa?.width ?? 0
      const baseH = wa?.height ?? 0

      if (baseW <= 0 || baseH <= 0 || previewWidth <= 0 || previewHeight <= 0) {
        return { scale: 1, x: 0, y: 0 }
      }

      const scale = Math.min(previewWidth / baseW, previewHeight / baseH)
      const contentW = baseW * scale
      const contentH = baseH * scale
      let x = Math.floor((previewWidth - contentW) / 2)
      let y = Math.floor((previewHeight - contentH) / 2)

      if (this._panelReservesStruts()) {
        const pos = this.panel?.geom?.position
        if (pos === St.Side.RIGHT) x = previewWidth - contentW
        else if (pos === St.Side.LEFT) x = 0
        else if (pos === St.Side.TOP) y = 0
        else if (pos === St.Side.BOTTOM) y = previewHeight - contentH
      }

      return { scale, x, y }
    }

    _getShortcutAppIds() {
      let ids = []
      try {
        ids = SETTINGS.get_strv('workspace-preview-shortcut-apps') || []
      } catch (e) {
        ids = []
      }

      // 固定 5 个槽位：用空字符串占位
      if (ids.length < SHORTCUT_SLOTS) {
        ids = ids.concat(Array(Math.max(0, SHORTCUT_SLOTS - ids.length)).fill(''))
      } else if (ids.length > SHORTCUT_SLOTS) {
        ids = ids.slice(0, SHORTCUT_SLOTS)
      }

      // 首次为空时：从“系统收藏”取前 5 个作为默认（之后与系统收藏脱钩）
      const allEmpty = ids.every((x) => !x)
      if (allEmpty) {
        try {
          const favs = AppFavorites.getAppFavorites()
          const favApps = favs.getFavorites?.() ?? []
          const fromFavs = []
          for (let a of favApps) {
            let id = a?.get_id?.()
            if (id) fromFavs.push(id)
            if (fromFavs.length >= SHORTCUT_SLOTS) break
          }
          if (fromFavs.length) {
            ids = fromFavs.concat(
              Array(Math.max(0, SHORTCUT_SLOTS - fromFavs.length)).fill(''),
            )
            SETTINGS.set_strv('workspace-preview-shortcut-apps', ids)
          }
        } catch (e) {
          // ignore
        }
      }

      return ids
    }

    _setShortcutAt(index, appId) {
      let ids = this._getShortcutAppIds()
      if (index < 0 || index >= SHORTCUT_SLOTS) return
      ids[index] = appId || ''
      try {
        SETTINGS.set_strv('workspace-preview-shortcut-apps', ids)
      } catch (e) {
        // ignore
      }
    }

    _removeShortcutAt(index) {
      this._setShortcutAt(index, '')
    }

    _ensureShortcutsBar() {
      if (this._shortcutsBar) return
      this._shortcutsBar = new St.Widget({
        layout_manager: new Clutter.BoxLayout({
          orientation: Clutter.Orientation.HORIZONTAL,
          spacing: 0,
        }),
        reactive: true,
        track_hover: true,
        x_expand: true,
        clip_to_allocation: true,
        style_class: 'workspace-preview-shortcuts-bar',
      })
      // 挂在 DTP Panel 根上，由 panel.js 分配区域
      this.panel.add_child(this._shortcutsBar)
      this._updateShortcutsBar()
    }

    _addWorkspaceItemBeforeShortcuts(item) {
      // workspace items 只添加到列表容器中，底部快捷栏不参与排序
      try {
        this._wsList?.add_child?.(item)
      } catch (e) {
        // ignore
      }
    }

    _buildShortcutMenu(slotIndex, anchorActor, stageX, stageY) {
      const menu = new PopupMenu.PopupMenu(
        anchorActor,
        0.5,
        this.panel.geom.position,
      )
      menu.blockSourceEvents = true
      Main.uiGroup.add_child(menu.actor)
      this._iconMenuManager.addMenu(menu)

      const ids = this._getShortcutAppIds()
      const currentId = ids?.[slotIndex] || ''

      if (currentId) {
        menu.addAction(_('Remove'), () => this._removeShortcutAt(slotIndex))
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem())
      }

      // 用“系统收藏”作为候选（轻量、直观）
      let favApps = []
      try {
        favApps = AppFavorites.getAppFavorites().getFavorites?.() ?? []
      } catch (e) {
        favApps = []
      }

      if (!favApps.length) {
        menu.addAction(_('No favorites'), () => {})
      } else {
        for (let app of favApps) {
          const id = app?.get_id?.()
          const name = app?.get_name?.() ?? id ?? ''
          if (!id) continue
          const item = new PopupMenu.PopupMenuItem(name)
          try {
            const icon = app.create_icon_texture?.(16) ?? null
            if (icon) item.insert_child_at_index(icon, 0)
          } catch (e) {
            // ignore
          }
          item.connect('activate', () => this._setShortcutAt(slotIndex, id))
          menu.addMenuItem(item)
        }
      }

      // 菜单定位：跟随鼠标，避免预览区溢出层/transform 造成偏移
      try {
        Main.layoutManager.setDummyCursorGeometry(stageX, stageY, 0, 0)
        menu.sourceActor = Main.layoutManager.dummyCursor
      } catch (e) {
        // ignore
      }

      menu.open(BoxPointer.PopupAnimation.FULL)
      this._iconMenuManager.ignoreRelease()
      return menu
    }

    _createShortcutButton(slotIndex, appId, iconSize, slotSize, vertical) {
      const isEmpty = !appId
      let child = null
      let targetApp = null

      if (!isEmpty) {
        try {
          targetApp = Shell.AppSystem.get_default().lookup_app(appId)
        } catch (e) {
          targetApp = null
        }
      }

      if (!isEmpty && targetApp) {
        try {
          child = new St.Icon({
            gicon: targetApp.get_icon(),
            icon_size: iconSize,
            style_class: 'workspace-preview-shortcut-icon',
          })
        } catch (e) {
          child = null
        }
      }

      if (!child) {
        child = new St.Icon({
          icon_name: 'list-add-symbolic',
          icon_size: Math.max(16, Math.round(iconSize * 0.8)),
          style_class: 'workspace-preview-shortcut-icon-placeholder',
        })
      }

      const btn = new St.Button({
        reactive: true,
        track_hover: true,
        can_focus: false,
        style_class: 'workspace-preview-shortcut-button',
        x_expand: !vertical,
        y_expand: !!vertical,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
      })
      if (vertical) btn.set_width(slotSize)
      else btn.set_height(slotSize)
      btn.set_child(child)

      btn.connect('button-press-event', (_a, event) => {
        let b = 1
        try {
          b = event.get_button()
        } catch (e) {
          b = 1
        }

        if (b === 1) {
          if (targetApp) {
            try {
              targetApp.activate()
            } catch (e) {
              // ignore
            }
          } else {
            try {
              const [sx, sy] = event.get_coords()
              this._buildShortcutMenu(slotIndex, btn, sx, sy)
            } catch (e) {
              // ignore
            }
          }
          return Clutter.EVENT_STOP
        }

        if (b === 3) {
          try {
            const [sx, sy] = event.get_coords()
            this._buildShortcutMenu(slotIndex, btn, sx, sy)
          } catch (e) {
            // ignore
          }
          return Clutter.EVENT_STOP
        }

        return Clutter.EVENT_PROPAGATE
      })

      return btn
    }

    _updateShortcutsBar() {
      if (!this._shortcutsBar) return

      const layout = this._getShortcutBarLayout()
      const ids = this._getShortcutAppIds()
      const vertical = !!layout.vertical

      try {
        const lm = this._shortcutsBar.get_layout_manager?.()
        lm?.set_spacing?.(0)
        if (lm && 'orientation' in lm) {
          lm.orientation = vertical
            ? Clutter.Orientation.VERTICAL
            : Clutter.Orientation.HORIZONTAL
        }
      } catch (e) {
        // ignore
      }

      try {
        if (vertical) {
          this._shortcutsBar.set_width(layout.barWidth)
          this._shortcutsBar.set_height(-1)
          this._shortcutsBar.x_expand = false
          this._shortcutsBar.y_expand = true
        } else {
          this._shortcutsBar.set_height(layout.barHeight)
          this._shortcutsBar.set_width(-1)
          this._shortcutsBar.x_expand = true
          this._shortcutsBar.y_expand = false
        }
      } catch (e) {
        // ignore
      }

      // 重建 5 个按钮（固定数量，直接重建简单可靠）
      try {
        for (let c of this._shortcutsBar.get_children?.() ?? []) c.destroy?.()
      } catch (e) {
        // ignore
      }
      this._shortcutsButtons = []

      const slotSize = vertical ? layout.barWidth : layout.barHeight
      for (let i = 0; i < SHORTCUT_SLOTS; i++) {
        const btn = this._createShortcutButton(
          i,
          ids[i],
          layout.iconSize,
          slotSize,
          vertical,
        )
        this._shortcutsButtons.push(btn)
        this._shortcutsBar.add_child(btn)
      }

      // 快捷栏尺寸变化会影响 workspace 可用空间，需重算 preview 几何
      this._timeoutsHandler.add([
        'ws-preview-shortcuts-reflow',
        0,
        () => this._updateWorkspacesGeometry(),
      ])
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

      // workspace 列表方向：侧栏纵向，上/下横向
      try {
        const lm = this._wsList?.get_layout_manager?.()
        if (lm && 'orientation' in lm) {
          lm.orientation = isSidePanel
            ? Clutter.Orientation.VERTICAL
            : Clutter.Orientation.HORIZONTAL
        }
      } catch (e) {
        // ignore
      }

      this._updateListSpacingForIconSize()
      this._updateShortcutsBar()
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
            // 频繁增删 workspace 时合并为一次同步（优先增量，必要时回退重建）
            this._timeoutsHandler.add([
              'ws-preview-rebuild',
              100,
              () => this._syncWorkspaceItems(),
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
              () => this._syncWorkspaceItems(),
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
        // 面板展开/收起会改变“应扣除”的占用区域，需同步缩略图 porthole
        [
          this.panel?.panelBox,
          ['notify::visible', 'notify::translation-x', 'notify::translation-y'],
          () => {
            this._timeoutsHandler.add([
              'ws-preview-panel-occupy',
              80,
              () => this._updateWorkspacesGeometry(),
            ])
          },
        ],
        [
          SETTINGS,
          'changed::intellihide',
          () => {
            this._timeoutsHandler.add([
              'ws-preview-intellihide',
              80,
              () => this._updateWorkspacesGeometry(),
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

      // workspace 名称变化时，只更新 label 文本，不重建
      if (this._wmPrefs) {
        this._signalsHandler.add([
          this._wmPrefs,
          'changed::workspace-names',
          () => this._updateWorkspaceNameLabels(),
        ])
      }
    }

    _syncWorkspaceItems() {
      // 尽量增量同步 workspace 数量变化：只增/删末尾，并更新索引/标签/激活态
      if (!this.panel) return

      let wm = null
      try {
        wm = Utils.DisplayWrapper.getWorkspaceManager()
      } catch (e) {
        wm = null
      }
      if (!wm) return

      const desired = wm.n_workspaces ?? 0
      const current = this._workspaceItems?.length ?? 0

      // 变动太大或异常场景：直接重建（更稳）
      if (desired < 0 || desired > 64) {
        this._updateWorkspaces()
        return
      }

      // 在任何同步前，先保证列表 spacing 与当前设置一致
      this._updateListSpacingForIconSize()
      this._ensureShortcutsBar()

      // 关键：动态工作区可能会“重排/压缩”（workspace 对象与 index 不再对应）。
      // 我们的增量同步只支持末尾增删；一旦检测到重排，直接回退全量重建，避免预览绑定到错误 workspace。
      if (!this._ensureWorkspaceBindings(wm)) return

      // 删除多余（从末尾删）
      if (current > desired) {
        for (let i = current - 1; i >= desired; i--) {
          const actor = this._workspaceItems.pop()
          if (!actor) continue
          try {
            // 先从父容器移除，再 destroy，避免 children 与 _workspaceItems 不一致
            const p = actor.get_parent?.()
            if (p) p.remove_child?.(actor)
          } catch (e) {
            // ignore
          }
          try {
            actor.destroy?.()
          } catch (e) {
            // ignore
          }
        }
        // workspace 索引变化后，稳定排序缓存可能错位：清空
        this._workspaceAppOrder?.clear?.()
        this._workspaceAppOrderNext?.clear?.()
      }

      // 新增（追加到末尾）
      if (current < desired) {
        let previewWidth = this._getPreviewColumnWidth()
        let namePosition = SETTINGS.get_string('workspace-preview-name-position')

        // previewHeight 复用计算逻辑
        let previewHeight = this._computePreviewHeight(
          previewWidth,
          desired,
          namePosition,
        )

        let activeWs = wm.get_active_workspace?.()
        for (let i = current; i < desired; i++) {
          let ws = wm.get_workspace_by_index(i)
          if (!ws) {
            // 回退：结构不符合预期
            this._updateWorkspaces()
            return
          }
          let isActive = ws === activeWs
          let item = this._createWorkspaceItem(
            ws,
            i,
            isActive,
            previewWidth,
            previewHeight,
            namePosition,
          )
          this._addWorkspaceItemBeforeShortcuts(item)
          this._workspaceItems.push(item)
        }
      }

      // 同步一次状态（索引/激活态/名称）
      for (let i = 0; i < this._workspaceItems.length; i++) {
        let item = this._workspaceItems[i]
        if (!item) continue
        item._dtwIndex = i
      }
      this._updateVisibility()
      this._updateActiveState()
      this._updateWorkspaceNameLabels()
      // 同步后确保快捷栏仍在最底部
      this._ensureShortcutsBar()
      this._updateShortcutsBar()
      this._lastWorkAreaKey = this._getWorkAreaKey()

      // 关键：同步后跑一次几何更新，确保新加的 workspace 预览缩放/位置正确
      this._updateWorkspacesGeometry()

      // 重要：增删 workspace 后，allocation 往往会在下一帧才稳定。
      // 再补一次 idle 重算，确保“超出才缩小”的判断拿到真实高度。
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        try {
          this._updateWorkspacesGeometry()
        } catch (e) {
          // ignore
        }
        return GLib.SOURCE_REMOVE
      })
    }

    _getWorkspaceDisplayText(index) {
      let displayText = `${index + 1}`
      try {
        let names = this._wmPrefs?.get_strv?.('workspace-names')
        if (names && names.length > index && names[index]) {
          displayText = `${index + 1}. ${names[index]}`
        }
      } catch (e) {
        // ignore
      }
      return displayText
    }

    _updateWorkspaceNameLabels() {
      // 只更新 label 文本与激活态颜色（避免重建造成闪动）
      let activeIndex = 0
      try {
        activeIndex = Utils.DisplayWrapper.getWorkspaceManager().get_active_workspace_index()
      } catch (e) {
        activeIndex = 0
      }

      for (let item of this._workspaceItems || []) {
        if (!item) continue
        let idx = item._dtwIndex ?? 0
        let text = this._getWorkspaceDisplayText(idx)
        if (item._dtwNameLabel) {
          try {
            item._dtwNameLabel.text = text
          } catch (e) {
            // ignore
          }
          this._applyNameLabelActiveStyle(item._dtwNameLabel, idx === activeIndex)
        }
      }
    }

    _getWorkAreaKey() {
      try {
        let wa = this._getWorkAreaForPreview()
        if (!wa) return null
        return `${wa.x},${wa.y},${wa.width},${wa.height}`
      } catch (e) {
        return null
      }
    }

    _ensureWorkspaceBindings(workspaceManager = null) {
      // 安全网：检测到 workspace 重排/错位时，立刻回退全量重建，避免“预览失效”
      if (this._dtwRebuildInProgress) return false
      if (!this.panel) return true

      let wm = workspaceManager
      if (!wm) {
        try {
          wm = Utils.DisplayWrapper.getWorkspaceManager()
        } catch (e) {
          wm = null
        }
      }
      if (!wm) return true

      try {
        const desired = wm.n_workspaces ?? 0
        const current = this._workspaceItems?.length ?? 0
        const n = Math.min(current, desired)
        for (let i = 0; i < n; i++) {
          const ws = wm.get_workspace_by_index(i)
          const item = this._workspaceItems[i]
          if (!ws || !item) {
            this._updateWorkspaces()
            return false
          }
          if (item._dtwWorkspace && item._dtwWorkspace !== ws) {
            this._updateWorkspaces()
            return false
          }
        }
      } catch (e) {
        this._updateWorkspaces()
        return false
      }

      return true
    }


    _updateWorkspacesGeometry() {
      // 仅更新缩略图/背景的 scale 和 position，避免重建导致卡顿
      if (!this.panel || !this._workspaceItems.length) return
      if (!this._ensureWorkspaceBindings()) return

      let namePosition = 'BOTTOM_RIGHT'
      try {
        namePosition = SETTINGS.get_string('workspace-preview-name-position')
      } catch (e) {
        namePosition = 'BOTTOM_RIGHT'
      }

      const side = this._isSidePanel()
      let previewWidth
      let previewHeight
      if (side) {
        previewWidth = this._getPreviewMainSize()
        previewHeight = this._computePreviewHeight(
          previewWidth,
          this._workspaceItems.length,
          namePosition,
        )
      } else {
        previewHeight = this._getPreviewMainSize()
        previewWidth = this._computePreviewWidth(
          previewHeight,
          this._workspaceItems.length,
          namePosition,
        )
      }

      let wa = this._getWorkAreaForPreview()

      for (let item of this._workspaceItems) {
        if (!item?._dtwPreviewArea || !item?._dtwPreviewStack) continue
        const itemPreviewWidth = side
          ? this._getItemPreviewWidth(item)
          : previewWidth
        const itemPreviewHeight = side
          ? previewHeight
          : this._getItemPreviewHeight(item, previewHeight)

        // 尺寸不变则不要 set_size（减少 relayout）
        try {
          if (
            item._dtwPreviewStack.width !== itemPreviewWidth ||
            item._dtwPreviewStack.height !== itemPreviewHeight
          )
            item._dtwPreviewStack.set_size(itemPreviewWidth, itemPreviewHeight)
        } catch (e) {
          item._dtwPreviewStack.set_size(itemPreviewWidth, itemPreviewHeight)
        }
        try {
          if (
            item._dtwPreviewArea.width !== itemPreviewWidth ||
            item._dtwPreviewArea.height !== itemPreviewHeight
          )
            item._dtwPreviewArea.set_size(itemPreviewWidth, itemPreviewHeight)
        } catch (e) {
          item._dtwPreviewArea.set_size(itemPreviewWidth, itemPreviewHeight)
        }

        const geomKey = wa
          ? `${itemPreviewWidth}x${itemPreviewHeight}__${wa.x},${wa.y},${wa.width},${wa.height}`
          : `${itemPreviewWidth}x${itemPreviewHeight}__no-wa`

        if (item._dtwLastGeomKey === geomKey) {
          // 叠加层仍需在尺寸变化时重算位置；这里让 updateLabelPos 自己去重
          try {
            item._dtwUpdateLabelPos?.(itemPreviewWidth, itemPreviewHeight)
          } catch (e) {
            // ignore
          }
          continue
        }
        item._dtwLastGeomKey = geomKey

        if (wa && wa.width > 0 && wa.height > 0) {
          const layout = this._getPreviewScaleLayout(
            itemPreviewWidth,
            itemPreviewHeight,
            wa,
          )

          try {
            item._dtwBackgroundGroup?.set_scale?.(layout.scale, layout.scale)
            item._dtwBackgroundGroup?.set_position?.(layout.x, layout.y)
          } catch (e) {
            // ignore
          }
          try {
            item._dtwThumbnail?.setScale?.(layout.scale, layout.scale)
            item._dtwThumbnail?.set_position?.(layout.x, layout.y)
          } catch (e) {
            // ignore
          }
          this._applyThumbnailPorthole(item, wa)
        }

        // 叠加层重算位置
        try {
          item._dtwUpdateLabelPos?.(itemPreviewWidth, itemPreviewHeight)
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
      }; background-color: rgba(0,0,0,0.55); padding: 2px 6px; border-radius: 4px;`
    }

    _handleRightClick(_actor, event) {
      // 统一的右键处理：切换 intellihide 状态（如果不在图标/按钮上）
      try {
        let button = event.get_button()
        if (button === 3) {
          // 检查是否点击在图标/按钮上（如果是，不处理，让各自菜单显示）
          let [stageX, stageY] = event.get_coords()
          let pickActor = global.stage.get_actor_at_pos(
            Clutter.PickMode.REACTIVE,
            stageX,
            stageY,
          )
          // 应用图标、快捷栏、+N 等 St.Button 自己处理右键
          let a = pickActor
          while (a && a !== this) {
            if (a._dtwApp || a instanceof St.Button)
              return Clutter.EVENT_PROPAGATE
            a = a.get_parent?.()
          }
          // 切换 intellihide 状态
          let currentState = SETTINGS.get_boolean('intellihide')
          let nextState = !currentState
          SETTINGS.set_boolean('intellihide', nextState)
          // 需求：开启自动隐藏时立即隐藏（不要等 enable-start-delay / close-delay）
          if (nextState) {
            // changed::intellihide 会同步触发 panel.intellihide.enable()；
            // 用 idle 确保 enable() 先完成，再执行“立即隐藏”
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
              try {
                this.panel?.intellihide?.hideImmediatelyAfterToggle?.()
              } catch (e) {
                // ignore
              }
              return GLib.SOURCE_REMOVE
            })
          }
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

    _getUniqueAppsFromWindows(windows, workspaceIndex = null) {
      // 去重后返回 app 列表。
      // 重要：这里不要用“最近使用(user_time)”排序，否则点击激活会改变 user_time，导致图标顺序互换。
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

      // 允许通过设置切换：稳定顺序 vs 最近使用排序
      let keepStable = true
      try {
        keepStable = SETTINGS.get_boolean('workspace-preview-app-icons-stable-order')
      } catch (e) {
        keepStable = true
      }
      if (!keepStable) {
        return Array.from(map.values())
          .sort((a, b) => (b.t ?? 0) - (a.t ?? 0))
          .map((x) => x.app)
      }

      // 稳定顺序：按“首次出现”固定排序（每个 workspace 独立）
      if (workspaceIndex !== null && workspaceIndex !== undefined) {
        let orderMap = this._workspaceAppOrder.get(workspaceIndex)
        if (!orderMap) {
          orderMap = new Map()
          this._workspaceAppOrder.set(workspaceIndex, orderMap)
        }

        let next = this._workspaceAppOrderNext.get(workspaceIndex) ?? 1

        // 新出现的 app 追加到末尾
        for (let id of map.keys()) {
          if (!orderMap.has(id)) {
            orderMap.set(id, next++)
          }
        }

        // 清理不再存在的 app，避免 orderMap 无限增长
        for (let id of Array.from(orderMap.keys())) {
          if (!map.has(id)) orderMap.delete(id)
        }

        this._workspaceAppOrderNext.set(workspaceIndex, next)

        return Array.from(map.entries())
          .sort((a, b) => {
            const ao = orderMap.get(a[0]) ?? 0
            const bo = orderMap.get(b[0]) ?? 0
            return ao - bo
          })
          .map(([, v]) => v.app)
      }

      // fallback：若没有 workspaceIndex，就保持插入顺序（Map 的 key 顺序）
      return Array.from(map.values()).map((x) => x.app)
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

      // Quit (all)
      let quitAll = menu.addAction(_('Quit'), () => {
        AppIcons.closeAllWindows(app, this.panel.monitor)
      })

      // 关闭后把 sourceActor 恢复到图标本身（我们右键时会临时改为 dummyCursor 以便定位到鼠标）
      menu.connect('open-state-changed', (_m, isOpen) => {
        if (isOpen) return
        try {
          menu.sourceActor = iconButton
          iconButton.sync_hover?.()
        } catch (e) {
          // ignore
        }
      })

      menu.connect('destroy', () => {
        iconButton._dtwMenu = null
      })

      iconButton._dtwMenu = menu
      iconButton._dtwQuitAllItem = quitAll
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
          iconButton._dtwQuitAllItem.setSensitive(countAll > 0)
          // 需求：菜单位置要正确（跟随鼠标/图标都行，但不能“跑偏”）。
          // 用 dummyCursor 作为临时 sourceActor，可以让菜单稳定出现在鼠标位置附近，
          // 不受图标所在容器（预览区/溢出层）的 transform/clip 影响。
          try {
            let [sx, sy] = event.get_coords()
            Main.layoutManager.setDummyCursorGeometry(sx, sy, 0, 0)
            iconButton._dtwMenu.sourceActor = Main.layoutManager.dummyCursor
          } catch (e) {
            // ignore
          }
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
        if (this._dtwDestroyed || !this._iconDrag || !this.panel) return Clutter.EVENT_PROPAGATE

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
      // 优化：只更新“上一个 focused + 当前 focused”，避免遍历所有图标
      if (!this._ensureWorkspaceBindings()) return
      let fw = null
      try {
        fw = global.display.focus_window
      } catch (e) {
        fw = null
      }

      let next = null
      if (fw) {
        try {
          const ws = fw.get_workspace?.()
          const wsIndex = ws?.index?.()
          const app = this._getWindowApp(fw)
          const appId = app?.get_id?.() ?? app?.get_name?.() ?? null
          if (wsIndex !== null && wsIndex !== undefined && appId) {
            next = { wsIndex, appId }
          }
        } catch (e) {
          next = null
        }
      }

      const prev = this._lastFocusedIcon
      if (
        prev &&
        next &&
        prev.wsIndex === next.wsIndex &&
        prev.appId === next.appId
      ) {
        return
      }

      const updateOne = (key) => {
        if (!key) return
        const item = this._workspaceItems?.[key.wsIndex]
        const map = item?._dtwAppIconButtons
        const btn = map?.get?.(key.appId)
        if (btn) this._updateIconFocusedState(btn)
      }

      // 先更新旧的（去掉高亮），再更新新的（加上高亮）
      updateOne(prev)
      updateOne(next)
      this._lastFocusedIcon = next
    }

    _canRefreshWorkspacesIncrementally() {
      if (!this._workspaceItems?.length) return false

      let wm
      try {
        wm = Utils.DisplayWrapper.getWorkspaceManager()
      } catch (e) {
        return false
      }

      const desired = wm?.n_workspaces ?? 0
      if (desired !== this._workspaceItems.length) return false

      for (let i = 0; i < desired; i++) {
        const ws = wm.get_workspace_by_index(i)
        const item = this._workspaceItems[i]
        if (!ws || !item) return false
        if (item._dtwWorkspace && item._dtwWorkspace !== ws) return false
      }

      return true
    }

    _refreshWorkspacesIncrementally() {
      this._updateListSpacingForIconSize()
      this._updateWorkspacesGeometry()
      this._updateActiveState()
      this._updateWorkspaceNameLabels()
      this._updateFocusedIcons()
      this._updateVisibility()
    }

    _updateWorkspaces() {
      if (this._dtwRebuildInProgress) return
      if (this._canRefreshWorkspacesIncrementally()) {
        this._refreshWorkspacesIncrementally()
        return
      }

      this._dtwRebuildInProgress = true
      this._cancelIconDrag()
      // 确保快捷栏存在（并且在重建后仍保留在底部）
      this._ensureShortcutsBar()
      // 清除旧的预览项
      this._workspaceItems.forEach((item) => {
        if (item) item.destroy()
      })
      this._workspaceItems = []

      // 清除所有 workspace items（只在 _wsList 内）
      try {
        for (let c of this._wsList?.get_children?.() ?? []) this._wsList.remove_child(c)
      } catch (e) {
        // ignore
      }

      // 更新布局间距（随图标尺寸动态调整）
      this._updateListSpacingForIconSize()

      let workspaceManager = Utils.DisplayWrapper.getWorkspaceManager()
      let workspaceCount = workspaceManager.n_workspaces
      let activeWorkspace = workspaceManager.get_active_workspace()

      let previewWidth
      let previewHeight
      let spacing = SETTINGS.get_int('workspace-preview-spacing')
      let namePosition = SETTINGS.get_string('workspace-preview-name-position')
      let isSidePanel = this._isSidePanel()

      if (isSidePanel) {
        previewWidth = this._getPreviewMainSize()
        previewHeight = this._computePreviewHeight(
          previewWidth,
          workspaceCount,
          namePosition,
        )
      } else {
        previewHeight = this._getPreviewMainSize()
        previewWidth = this._computePreviewWidth(
          previewHeight,
          workspaceCount,
          namePosition,
        )
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
        this._addWorkspaceItemBeforeShortcuts(item)
        this._workspaceItems.push(item)
      }

      this._updateShortcutsBar()

      // 更新布局/可见性
      this._updateVisibility()

      // 重建后同步一次激活态（防止时序导致状态不一致）
      this._updateActiveState()
      // 同步一次名称（避免启动阶段 workspace-names 尚未 ready）
      this._updateWorkspaceNameLabels()

      // 记录当前 workarea key（用于去抖）
      this._lastWorkAreaKey = this._getWorkAreaKey()

      // 重建后清空 focused 追踪，避免 wsIndex 指向旧列表
      this._lastFocusedIcon = null
      this._dtwRebuildInProgress = false

      // 重建后下一帧再补一次几何更新：确保 allocation 完全稳定后再计算缩放
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        try {
          this._updateWorkspacesGeometry()
        } catch (e) {
          // ignore
        }
        return GLib.SOURCE_REMOVE
      })
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
        reactive: true,
        track_hover: true,
        x_expand: this._isSidePanel(),
        y_expand: !this._isSidePanel(),
      })
      container._dtwIndex = index
      container._dtwWorkspace = workspace
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
        x_expand: true,
      })
      container._dtwPreviewStack = previewStack

      // 预览区域（只显示 workspace 内容，保持裁切）
      let previewArea = new St.Widget({
        width: previewWidth,
        height: previewHeight,
        style_class: 'workspace-preview-area',
        clip_to_allocation: true,
        layout_manager: new Clutter.BinLayout(),
        reactive: true,
        track_hover: true,
        x_expand: true,
      })
      container._dtwPreviewArea = previewArea

      // 背景层：显示桌面壁纸（即使没有窗口也不会是黑色）
      // 注意：这不是 workspace 内容的一部分，但视觉上符合“预览桌面背景”
      let bgManager = null
      // 用与 WorkspaceThumbnail 相同的 porthole（workArea）比例来缩放/居中背景。
      // 这里使用“cover”（铺满裁切）避免预览区出现留白。
      let wa = null
      try {
        wa = this._getWorkAreaForPreview()
      } catch (e) {
        wa = null
      }

      try {
        let backgroundGroup = new Meta.BackgroundGroup()
        if (wa) {
          backgroundGroup.set_size(wa.width, wa.height)
          const layout = this._getPreviewScaleLayout(
            previewWidth,
            previewHeight,
            wa,
          )
          backgroundGroup.set_scale(layout.scale, layout.scale)
          backgroundGroup.set_position(layout.x, layout.y)
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

        if (!wa) wa = this._getWorkAreaForPreview()
        const tmbLayout = this._getPreviewScaleLayout(
          previewWidth,
          previewHeight,
          wa,
        )
        tmb.setScale(tmbLayout.scale, tmbLayout.scale)
        tmb.set_position(tmbLayout.x, tmbLayout.y)

        previewArea.add_child(tmb)
        container._dtwThumbnail = tmb
        this._applyThumbnailPorthole(container, wa)
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
      let displayText = this._getWorkspaceDisplayText(index)

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
        container._dtwIconsBox = iconsBox
        // badge 计算缓存：避免频繁 get_children / 重算
        container._dtwBadgeIconCount = 0
        container._dtwLastBadgeIconSize = 0

        overlayLayer.add_child(badge)
        
        // 记录图标尺寸，用于固定计算（避免图标加入后 preferred_size 变化导致布局错乱）
        let badgeIconSize = DEFAULT_APP_ICON_SIZE

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
        let nameMargin = 2
        let updateLabelPos = (forcedW = null, forcedH = null) => {
          // 只在必要时把叠加层置顶（避免每次都做 set_child_above_sibling）
          try {
            const last = previewStack.get_last_child?.()
            if (last !== container._dtwNameOverlayLayer) {
              previewStack.set_child_above_sibling(container._dtwOverlayLayer, null)
              previewStack.set_child_above_sibling(container._dtwNameOverlayLayer, null)
            }
          } catch (e) {
            // fallback：保持原逻辑
            try {
              previewStack.set_child_above_sibling(container._dtwOverlayLayer, null)
              previewStack.set_child_above_sibling(container._dtwNameOverlayLayer, null)
            } catch (e2) {
              // ignore
            }
          }

          // 尽量避免读取 allocation_box（它可能高频触发）；尺寸通常由 set_size 决定
          let w = forcedW ?? previewArea.width ?? 0
          let h = forcedH ?? previewArea.height ?? 0
          if (!w || !h) {
            try {
              let box = previewArea.get_allocation_box()
              w = box.x2 - box.x1
              h = box.y2 - box.y1
            } catch (e) {
              // ignore
            }
          }

          // 同步 overlayLayer 的尺寸（确保它覆盖整个 previewArea 内部）
          try {
            if (
              container._dtwOverlayLayer.width !== w ||
              container._dtwOverlayLayer.height !== h
            )
              container._dtwOverlayLayer.set_size(w, h)
          } catch (e) {
            container._dtwOverlayLayer.set_size(w, h)
          }
          try {
            if (
              container._dtwNameOverlayLayer.width !== w ||
              container._dtwNameOverlayLayer.height !== h
            )
              container._dtwNameOverlayLayer.set_size(w, h)
          } catch (e) {
            container._dtwNameOverlayLayer.set_size(w, h)
          }

          // 计算 badge 的尺寸（用固定计算，避免图标加入后 preferred_size 变化）
          // 图标数量（最多 APP_ICON_MAX 个）
          let iconCount = Math.min(container._dtwBadgeIconCount ?? 0, APP_ICON_MAX)
          // 图标间距（从 CSS 读取或默认 4px）
          let iconSpacing = 4
          // badge 宽度 = 图标数量 × 图标尺寸 + (数量-1) × 间距
          let natW = iconCount * badgeIconSize + Math.max(0, iconCount - 1) * iconSpacing
          // badge 高度 = 图标尺寸
          let natH = badgeIconSize

          // 若尺寸/数量都没变，跳过重算（但上面的“置顶”仍已执行）
          const key = `${w}x${h}__${natW}x${natH}__${namePosition}`
          if (container._dtwLastBadgePosKey === key) return
          container._dtwLastBadgePosKey = key

          // 计算 badge 在 overlayLayer 内部的坐标（相对于 overlayLayer 的 0,0）
          // x: 左下角 = margin，右下角 = w - natW - margin
          let x =
            namePosition == 'BOTTOM_LEFT'
              ? margin
              : Math.max(margin, w - natW - margin)
          // y: 向下再降半个图标高度（总共溢出 1 个图标高度），并配合列表间距避免遮挡
          let y = Math.max(margin, h - natH - margin + Math.floor(natH))

          badge.set_position(x, y)

          // 顶部序号：贴左上角
          let [, , nameW, nameH] = nameLabel.get_preferred_size()
          let nameX = nameMargin
          let nameY = nameMargin
          nameLabel.set_position(nameX, nameY)
        }
        container._dtwUpdateLabelPos = updateLabelPos

        // 图标刷新（只更新这一项，不重建整个预览列表）
        const tracker = Shell.WindowTracker.get_default()
        const updateAppIcons = () => {
          let windows = this._listWorkspaceWindows(workspace)

          // 图标大小固定，避免选中时变化
          let iconSize = this._getPreviewAppIconSize()
          // 同步更新 badge 图标尺寸（用于固定计算）
          badgeIconSize = iconSize

          // 去重：同一应用只显示一次
          let apps = this._getUniqueAppsFromWindows(windows, index)

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
          const sig = `${iconSize}__${ids}__${hidden.length}`
          if (container._dtwIconSig === sig) {
            updateLabelPos()
            return
          }
          container._dtwIconSig = sig

          // 现在才清空（避免无谓 destroy/recreate）
          iconsBox.get_children().forEach((c) => c.destroy())
          // appId -> iconButton（用于 focused 状态增量更新）
          container._dtwAppIconButtons = new Map()
          // 缓存 badge 所需的 iconCount（包含 +N 按钮）
          container._dtwBadgeIconCount = Math.min(
            shown.length + (total > APP_ICON_MAX ? 1 : 0),
            APP_ICON_MAX,
          )
          container._dtwLastBadgeIconSize = iconSize

          for (let app of shown) {
            let iconButton = this._createPreviewAppIconButton({
              app,
              workspace,
              iconSize,
              tracker,
            })
            if (iconButton) {
              iconsBox.add_child(iconButton)
              try {
                const id = app.get_id?.() ?? app.get_name?.() ?? String(app)
                container._dtwAppIconButtons.set(id, iconButton)
              } catch (e) {
                // ignore
              }
            }
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

        // 初次定位（后续由 _updateWorkspacesGeometry / updateAppIcons 触发定位）
        updateLabelPos()
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

      // 右键由 WorkspacePreviewView 根节点的 captured-event 统一处理
      // （不要在 previewStack/previewArea 再挂一份，否则可能连点两次等于没切换）

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
      this._dtwDestroyed = true
      this._cancelIconDrag()
      this._workspaceItems.forEach((item) => item.destroy())
      this._workspaceItems = []

      try {
        this._shortcutsButtons?.forEach?.((b) => b?.destroy?.())
      } catch (e) {
        // ignore
      }
      this._shortcutsButtons = []
      try {
        this._shortcutsBar?.destroy?.()
      } catch (e) {
        // ignore
      }
      this._shortcutsBar = null

      try {
        this._wmPrefs?.run_dispose?.()
      } catch (e) {
        // ignore
      }
      this._wmPrefs = null

      this._signalsHandler.destroy()
      this._timeoutsHandler.destroy()
      super.destroy()
    }
  },
)
