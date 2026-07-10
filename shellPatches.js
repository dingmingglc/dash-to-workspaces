/*
 * Centralized GNOME Shell monkey-patches used by Dash to Workspaces.
 * Keeps panelManager.js focused on panel lifecycle.
 */

import Clutter from 'gi://Clutter'
import GObject from 'gi://GObject'
import Meta from 'gi://Meta'
import Shell from 'gi://Shell'
import St from 'gi://St'

import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js'
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js'
import * as LookingGlass from 'resource:///org/gnome/shell/ui/lookingGlass.js'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js'
import { InjectionManager } from 'resource:///org/gnome/shell/extensions/extension.js'
import {
  SecondaryMonitorDisplay,
  WorkspacesView,
} from 'resource:///org/gnome/shell/ui/workspacesView.js'

import * as Panel from './panel.js'
import * as ShellCompat from './compat/shellCompat.js'
import * as Utils from './utils.js'
import { SETTINGS, USE_SAFE_DEFAULTS_CONFLICTING } from './extension.js'

export class ShellPatches {
  constructor(panelManager) {
    this._pm = panelManager
    this._injectionManager = new InjectionManager()
    this._skippedOverviewHotCornerPatch = false
    this._patched = false
  }

  get skippedOverviewHotCornerPatch() {
    return this._skippedOverviewHotCornerPatch
  }

  /** Patches that must exist before panels are created (safe to call on reset). */
  enableCore() {
    if (!AppDisplay.AppIcon.prototype._removeMenuTimeout)
      AppDisplay.AppIcon.prototype._setPopupTimeout =
        AppDisplay.AppIcon.prototype._removeMenuTimeout = this._emptyFunc

    if (this._oldFindIndexForActor === undefined) {
      this._oldFindIndexForActor = Main.layoutManager.findIndexForActor
      Main.layoutManager.findIndexForActor = (actor) => {
        if ('_dtpIndex' in actor) return actor._dtpIndex
        let prev = this._oldFindIndexForActor
        if (typeof prev === 'function')
          return prev.call(Main.layoutManager, actor)
        return Layout.LayoutManager.prototype.findIndexForActor.call(
          Main.layoutManager,
          actor,
        )
      }
    }
  }

  /** Full patches (skipped when enable(reset=true) short-circuits). */
  enableFull() {
    if (this._patched) return
    this._patched = true

    let dtpActive =
      USE_SAFE_DEFAULTS_CONFLICTING ||
      !!(global.dashToPanel && global.dashToPanel.panels)
    this._skippedOverviewHotCornerPatch = dtpActive

    if (!dtpActive) this._patchHotCornersAndOverview()

    this._patchInjections()
    this._patchLookingGlass()
    this._patchMessageTray()
    this._patchLayoutUpdateBoxes()

    let keepTop =
      USE_SAFE_DEFAULTS_CONFLICTING ||
      SETTINGS.get_boolean('stockgs-keep-top-panel')
    if (!keepTop)
      Object.defineProperty(Main.panel, 'style', {
        configurable: true,
        set() {},
      })
  }

  disableFull() {
    if (!this._patched) return
    this._patched = false

    if (!this._skippedOverviewHotCornerPatch) this._unpatchHotCornersAndOverview()

    this._injectionManager.clear()

    if (this._oldLayoutUpdateBoxes) {
      Main.layoutManager._updateBoxes = this._oldLayoutUpdateBoxes
      this._oldLayoutUpdateBoxes = null
    }

    if (LookingGlass.LookingGlass.prototype._oldResize) {
      LookingGlass.LookingGlass.prototype._resize =
        LookingGlass.LookingGlass.prototype._oldResize
      delete LookingGlass.LookingGlass.prototype._oldResize
    }

    if (LookingGlass.LookingGlass.prototype._oldOpen) {
      LookingGlass.LookingGlass.prototype.open =
        LookingGlass.LookingGlass.prototype._oldOpen
      delete LookingGlass.LookingGlass.prototype._oldOpen
    }

    if (Main.messageTray._bannerBin.ease)
      delete Main.messageTray._bannerBin.ease

    if (!USE_SAFE_DEFAULTS_CONFLICTING) delete Main.panel.style
  }

  disableCore() {
    if (AppDisplay.AppIcon.prototype._removeMenuTimeout == this._emptyFunc) {
      delete AppDisplay.AppIcon.prototype._setPopupTimeout
      delete AppDisplay.AppIcon.prototype._removeMenuTimeout
    }

    if (this._oldFindIndexForActor !== undefined) {
      Main.layoutManager.findIndexForActor = this._oldFindIndexForActor
      this._oldFindIndexForActor = undefined
    } else {
      delete Main.layoutManager.findIndexForActor
    }
  }

  _patchHotCornersAndOverview() {
    const wsDisplay = ShellCompat.getWorkspacesDisplay()
    if (!wsDisplay) return

    this._oldUpdateHotCorners = Main.layoutManager._updateHotCorners
    Main.layoutManager._updateHotCorners = newUpdateHotCorners.bind(
      Main.layoutManager,
    )
    Main.layoutManager._updateHotCorners()

    this._forceHotCornerId = SETTINGS.connect(
      'changed::stockgs-force-hotcorner',
      () => Main.layoutManager._updateHotCorners(),
    )

    if (Main.layoutManager._interfaceSettings) {
      this._enableHotCornersId = Main.layoutManager._interfaceSettings.connect(
        'changed::enable-hot-corners',
        () => Main.layoutManager._updateHotCorners(),
      )
    }

    this._oldUpdateWorkspacesViews = wsDisplay._updateWorkspacesViews
    wsDisplay._updateWorkspacesViews = this._pm._newUpdateWorkspacesViews.bind(
      wsDisplay,
    )

    this._oldSetPrimaryWorkspaceVisible = wsDisplay.setPrimaryWorkspaceVisible
    wsDisplay.setPrimaryWorkspaceVisible =
      this._pm._newSetPrimaryWorkspaceVisible.bind(wsDisplay)
  }

  _unpatchHotCornersAndOverview() {
    const wsDisplay = ShellCompat.getWorkspacesDisplay()
    if (wsDisplay && this._oldUpdateWorkspacesViews) {
      wsDisplay._updateWorkspacesViews = this._oldUpdateWorkspacesViews
      wsDisplay.setPrimaryWorkspaceVisible =
        this._oldSetPrimaryWorkspaceVisible
    }

    if (this._oldUpdateHotCorners) {
      Main.layoutManager._updateHotCorners = this._oldUpdateHotCorners
      Main.layoutManager._updateHotCorners()
    }

    if (this._forceHotCornerId)
      SETTINGS.disconnect(this._forceHotCornerId)
    if (this._enableHotCornersId)
      Main.layoutManager._interfaceSettings?.disconnect(
        this._enableHotCornersId,
      )
  }

  _patchInjections() {
    let panelManager = this._pm
    this._injectionManager.overrideMethod(
      BoxPointer.BoxPointer.prototype,
      'vfunc_get_preferred_height',
      () =>
        function (forWidth) {
          let alloc = { min_size: 0, natural_size: 0 }
          ;[alloc.min_size, alloc.natural_size] =
            this.vfunc_get_preferred_height(forWidth)
          return panelManager._getBoxPointerPreferredHeight(this, alloc)
        },
    )

    let activitiesChild = Main.panel.statusArea.activities.get_first_child()
    if (activitiesChild?.constructor.name == 'WorkspaceIndicators') {
      this._injectionManager.overrideMethod(
        Object.getPrototypeOf(activitiesChild.get_first_child()),
        'vfunc_get_preferred_width',
        (get_preferred_width) =>
          function (forHeight) {
            return Utils.getBoxLayoutVertical(this.get_parent())
              ? [0, forHeight]
              : get_preferred_width.call(this, forHeight)
          },
      )
    }
  }

  _patchLookingGlass() {
    LookingGlass.LookingGlass.prototype._oldResize =
      LookingGlass.LookingGlass.prototype._resize
    LookingGlass.LookingGlass.prototype._resize = _newLookingGlassResize

    LookingGlass.LookingGlass.prototype._oldOpen =
      LookingGlass.LookingGlass.prototype.open
    LookingGlass.LookingGlass.prototype.open = _newLookingGlassOpen
  }

  _patchMessageTray() {
    const panelManager = this._pm
    Main.messageTray._bannerBin.ease = (params) => {
      if (params.y === 0) {
        let panelOnPrimary = panelManager.allPanels.find(
          (p) => p.monitor == Main.layoutManager.primaryMonitor,
        )
        if (
          panelOnPrimary &&
          panelOnPrimary.intellihide?.enabled &&
          panelOnPrimary.geom.position == St.Side.TOP &&
          panelOnPrimary.panelBox.visible
        )
          params.y += panelOnPrimary.geom.outerSize
      }
      Object.getPrototypeOf(Main.messageTray._bannerBin).ease.call(
        Main.messageTray._bannerBin,
        params,
      )
    }
  }

  _patchLayoutUpdateBoxes() {
    const panelManager = this._pm
    this._oldLayoutUpdateBoxes = Main.layoutManager._updateBoxes
    Main.layoutManager._updateBoxes = (...args) => {
      if (typeof this._oldLayoutUpdateBoxes === 'function')
        this._oldLayoutUpdateBoxes.apply(Main.layoutManager, args)
      panelManager._updateTopPanelBoxFromWorkArea()
    }
  }

  _emptyFunc() {}
}

function newUpdateHotCorners() {
  this.hotCorners.forEach(function (corner) {
    if (corner) corner.destroy()
  })
  this.hotCorners = []

  if (
    (global.settings.list_keys().indexOf('enable-hot-corners') >= 0 &&
      !global.settings.get_boolean('enable-hot-corners')) ||
    (this._interfaceSettings &&
      !this._interfaceSettings.get_boolean('enable-hot-corners'))
  ) {
    this.emit('hot-corners-changed')
    return
  }

  for (let i = 0; i < this.monitors.length; i++) {
    let panel = Utils.find(
      global.workspacesToDock.panels,
      (p) => p.monitor.index == i,
    )
    let panelPosition = panel ? panel.geom.position : St.Side.BOTTOM
    let panelTopLeft =
      panelPosition == St.Side.TOP || panelPosition == St.Side.LEFT
    let monitor = this.monitors[i]
    let cornerX = this._rtl ? monitor.x + monitor.width : monitor.x
    let cornerY = monitor.y
    let haveTopLeftCorner = true

    if (
      i != this.primaryIndex ||
      (!panelTopLeft && !SETTINGS.get_boolean('stockgs-force-hotcorner'))
    ) {
      let besideX = this._rtl ? monitor.x + 1 : cornerX - 1
      let besideY = cornerY
      let aboveX = cornerX
      let aboveY = cornerY - 1

      for (let j = 0; j < this.monitors.length; j++) {
        if (i == j) continue
        let otherMonitor = this.monitors[j]
        if (
          besideX >= otherMonitor.x &&
          besideX < otherMonitor.x + otherMonitor.width &&
          besideY >= otherMonitor.y &&
          besideY < otherMonitor.y + otherMonitor.height
        ) {
          haveTopLeftCorner = false
          break
        }
        if (
          aboveX >= otherMonitor.x &&
          aboveX < otherMonitor.x + otherMonitor.width &&
          aboveY >= otherMonitor.y &&
          aboveY < otherMonitor.y + otherMonitor.height
        ) {
          haveTopLeftCorner = false
          break
        }
      }
    }

    if (haveTopLeftCorner) {
      let corner = new Layout.HotCorner(this, monitor, cornerX, cornerY)
      corner.setBarrierSize = (size) =>
        Object.getPrototypeOf(corner).setBarrierSize.call(
          corner,
          Math.min(size, Panel.GS_PANEL_SIZE),
        )
      corner.setBarrierSize(panel ? panel.geom.innerSize : Panel.GS_PANEL_SIZE)
      this.hotCorners.push(corner)
    } else {
      this.hotCorners.push(null)
    }
  }

  this.emit('hot-corners-changed')
}

function _newLookingGlassResize() {
  let primaryMonitorPanel = Utils.find(
    global.workspacesToDock.panels,
    (p) => p.monitor == Main.layoutManager.primaryMonitor,
  )
  let keepTop =
    USE_SAFE_DEFAULTS_CONFLICTING ||
    SETTINGS.get_boolean('stockgs-keep-top-panel')
  let topOffset =
    primaryMonitorPanel.geom.position == St.Side.TOP
      ? primaryMonitorPanel.geom.outerSize +
        (keepTop ? Main.layoutManager.panelBox.height : 0) +
        8
      : Panel.GS_PANEL_SIZE

  this._oldResize()
  this._hiddenY = Main.layoutManager.primaryMonitor.y + topOffset - this.height
  this._targetY = this._hiddenY + this.height
  this.y = this._hiddenY
  this._objInspector.set_position(
    this.x + Math.floor(this.width * 0.1),
    this._targetY + Math.floor(this.height * 0.1),
  )
}

function _newLookingGlassOpen() {
  if (this._open) return
  this._resize()
  this._oldOpen()
}

export { WorkspacesView, SecondaryMonitorDisplay }
