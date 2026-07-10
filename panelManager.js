/*
 * This file is part of the Dash-To-Panel extension for Gnome 3
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * Credits:
 * This file is based on code from the Dash to Dock extension by micheleg
 * and code from the Taskbar extension by Zorin OS
 *
 * Code to re-anchor the panel was taken from Thoma5 BottomPanel:
 * https://github.com/Thoma5/gnome-shell-extension-bottompanel
 *
 * Pattern for moving clock based on Frippery Move Clock by R M Yorston
 * http://frippery.org/extensions/
 *
 * Some code was also adapted from the upstream Gnome Shell source code.
 */

import * as Overview from './overview.js'
import * as Panel from './panel.js'
import * as PanelSettings from './panelSettings.js'
import * as Proximity from './proximity.js'
import * as Utils from './utils.js'
import * as DesktopIconsIntegration from './desktopIconsIntegration.js'
import * as ShellCompat from './compat/shellCompat.js'
import { ShellPatches } from './shellPatches.js'
import {
  PANEL_FULL_RESET_KEYS,
  PANEL_GEOMETRY_REFRESH_KEYS,
} from './prefs/constants.js'
import {
  DTP_EXTENSION,
  SETTINGS,
  tracker,
  USE_SAFE_DEFAULTS_CONFLICTING,
} from './extension.js'

import GLib from 'gi://GLib'
import GObject from 'gi://GObject'
import Clutter from 'gi://Clutter'
import Meta from 'gi://Meta'
import Shell from 'gi://Shell'
import St from 'gi://St'

import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js'
import { NotificationsMonitor } from './notificationsMonitor.js'
import { Workspace } from 'resource:///org/gnome/shell/ui/workspace.js'
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js'
import { WorkspacesView, SecondaryMonitorDisplay } from './shellPatches.js'

export const PanelManager = class {
  constructor() {
    this.overview = new Overview.Overview(this)
    this._shellPatches = new ShellPatches(this)
  }

  enable(reset) {
    // 位置设置保留：允许用户调整 primary-monitor 和 multi-monitors
    let primaryMonitor = SETTINGS.get_string('primary-monitor')
    let dtpPrimaryIndex = PanelSettings.getPrimaryIndex(primaryMonitor)

    this.allPanels = []
    this.dtpPrimaryMonitor =
      Main.layoutManager.monitors[dtpPrimaryIndex] ||
      Main.layoutManager.primaryMonitor
    this.proximityManager = new Proximity.ProximityManager()
    this.notificationsMonitor = new NotificationsMonitor()

    this._shellPatches.enableCore()

    let keepTopPanel =
      USE_SAFE_DEFAULTS_CONFLICTING || SETTINGS.get_boolean('stockgs-keep-top-panel')

    if (this.dtpPrimaryMonitor) {
      this.primaryPanel = this._createPanel(
        this.dtpPrimaryMonitor,
        keepTopPanel,
      )
      this.allPanels.push(this.primaryPanel)
      this.overview.enable(this.primaryPanel)

      this.setFocusedMonitor(this.dtpPrimaryMonitor)
    }

    // 位置设置保留：允许用户启用多显示器
    let multiMonitors = SETTINGS.get_boolean('multi-monitors')
    if (multiMonitors) {
      Main.layoutManager.monitors
        .filter((m) => m != this.dtpPrimaryMonitor)
        .forEach((m) => {
          this.allPanels.push(this._createPanel(m, true))
        })
    }

    global.workspacesToDock.panels = this.allPanels
    global.workspacesToDock.emit('panels-created')

    this._setDesktopIconsMargins()

    this._updatePanelElementPositions()

    if (reset) return

    this._desktopIconsUsableArea =
      new DesktopIconsIntegration.DesktopIconsUsableAreaClass()

    this._shellPatches.enableFull()
    this._skippedOverviewHotCornerPatch =
      this._shellPatches.skippedOverviewHotCornerPatch

    this._signalsHandler = new Utils.GlobalSignalsHandler()

    this._signalsHandler.add(
      [
        SETTINGS,
        'changed::global-border-radius',
        () => DTP_EXTENSION.resetGlobalStyles(),
      ],
      [
        SETTINGS,
        PANEL_FULL_RESET_KEYS.map((k) => `changed::${k}`),
        (settings, settingChanged) => {
          PanelSettings.clearCache(settingChanged)
          this._reset()
        },
      ],
      [
        SETTINGS,
        'changed::panel-element-positions',
        () => {
          PanelSettings.clearCache('panel-element-positions')
          this._updatePanelElementPositions()
        },
      ],
      [
        SETTINGS,
        PANEL_GEOMETRY_REFRESH_KEYS.map((k) => `changed::${k}`),
        (settings, settingChanged) => {
          PanelSettings.clearCache(settingChanged)
          this._refreshAllPanelGeometry()
          GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this._setDesktopIconsMargins()
            return GLib.SOURCE_REMOVE
          })
        },
      ],
      [
        SETTINGS,
        'changed::intellihide-key-toggle-text',
        () => this._setKeyBindings(true),
      ],
      [
        Utils.DisplayWrapper.getMonitorManager(),
        'monitors-changed',
        async () => {
          if (Main.layoutManager.primaryMonitor) {
            await PanelSettings.setMonitorsInfo(SETTINGS).catch((e) =>
              console.log(e),
            )
            this._reset()
          }
        },
      ],
      [global.display, 'workareas-changed', () => this._queueUpdateTopPanelBox()],
    )

    // 在 USE_SAFE_DEFAULTS_CONFLICTING 模式下，不监听 Main.panel 的信号
    // 因为可能只使用自己的独立面板，不修改 Main.panel
    if (!USE_SAFE_DEFAULTS_CONFLICTING) {
      Panel.panelBoxes.forEach((c) =>
        this._signalsHandler.add([
          Main.panel[c],
          'child-added',
          (parent, child) => {
            this.primaryPanel &&
              child instanceof St.Bin &&
              this._adjustPanelMenuButton(
                this._getPanelMenuButton(child.get_first_child()),
                this.primaryPanel.monitor,
                this.primaryPanel.geom.position,
              )
          },
        ]),
      )
    }

    this._setKeyBindings(true)
    this._queueUpdateTopPanelBox()
  }

  _refreshAllPanelGeometry() {
    this.allPanels.forEach((p) => {
      try {
        p._resetGeometry?.()
      } catch (e) {
        // ignore
      }
    })
  }

  disable(reset) {
    this.primaryPanel && this.overview.disable()
    this.proximityManager.destroy()
    this.notificationsMonitor?.destroy()
    this.notificationsMonitor = null

    this.allPanels.forEach((p) => {
      p.taskbar.iconAnimator.pause()

      this._findPanelMenuButtons(p.panelBox).forEach((pmb) => {
        if (pmb.menu._boxPointer._dtpGetPreferredHeightId) {
          pmb.menu._boxPointer._container.disconnect(
            pmb.menu._boxPointer._dtpGetPreferredHeightId,
          )
        }

        pmb.menu._boxPointer.sourceActor = pmb.menu._boxPointer._dtpSourceActor
        delete pmb.menu._boxPointer._dtpSourceActor
        pmb.menu._boxPointer._userArrowSide = St.Side.TOP
      })

      this._removePanelBarriers(p)

      p.disable()

      Main.layoutManager._untrackActor(p)
      Main.layoutManager._untrackActor(p.panelBox)

      if (p.isStandalone) {
        p.panelBox.destroy()
      } else {
        p.panelBox.remove_child(p)
        p.remove_child(p.panel)
        p.panelBox.add_child(p.panel)

        p.panelBox.set_position(p.clipContainer.x, p.clipContainer.y)

        delete p.panelBox._dtpIndex

        p.clipContainer.remove_child(p.panelBox)
        Main.layoutManager.addChrome(p.panelBox, {
          affectsStruts: true,
          trackFullscreen: true,
        })
      }

      Main.layoutManager.removeChrome(p.clipContainer)
    })

    if (Main.layoutManager.primaryMonitor) {
      Main.layoutManager.panelBox.set_position(
        Main.layoutManager.primaryMonitor.x,
        Main.layoutManager.primaryMonitor.y,
      )
      Main.layoutManager.panelBox.set_size(
        Main.layoutManager.primaryMonitor.width,
        -1,
      )
    }

    if (reset) return

    this._setKeyBindings(false)
    this._shellPatches.disableFull()

    this._signalsHandler.destroy()

    this._shellPatches.disableCore()
    this._desktopIconsUsableArea.destroy()
    this._desktopIconsUsableArea = null
  }

  _emptyFunc() {}

  _queueUpdateTopPanelBox() {
    if (this._topPanelBoxUpdateQueued) return
    this._topPanelBoxUpdateQueued = true
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      this._topPanelBoxUpdateQueued = false
      this._updateTopPanelBoxFromWorkArea()
      return GLib.SOURCE_REMOVE
    })
  }

  _updateTopPanelBoxFromWorkArea() {
    // 仅当 layoutManager.panelBox 仍在 layoutManager.uiGroup 下（原生顶栏容器）才处理：
    // 如果 panelBox 被其它扩展 removeChrome()/reparent（例如 Dash to Panel 接管），不要动它。
    try {
      const parent = Main.layoutManager.panelBox.get_parent()
      if (parent !== Main.layoutManager.uiGroup)
        return
    } catch (e) {
      return
    }
    if (!Main.layoutManager.primaryMonitor) return

    const primary = Main.layoutManager.primaryMonitor
    let wa
    try {
      wa = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex)
    } catch (e) {
      return
    }
    if (!wa) return

    // y 仍使用 monitor.y（顶栏必须在屏幕顶部），x/width 使用 work area（避让侧边 strut）
    Main.layoutManager.panelBox.set_position(wa.x, primary.y)
    Main.layoutManager.panelBox.set_size(wa.width, -1)
  }

  _setDesktopIconsMargins() {
    this._desktopIconsUsableArea?.resetMargins()
    this.allPanels.forEach((p) => {
      switch (p.geom.position) {
        case St.Side.TOP:
          this._desktopIconsUsableArea?.setMargins(
            p.monitor.index,
            p.geom.outerSize,
            0,
            0,
            0,
          )
          break
        case St.Side.BOTTOM:
          this._desktopIconsUsableArea?.setMargins(
            p.monitor.index,
            0,
            p.geom.outerSize,
            0,
            0,
          )
          break
        case St.Side.LEFT:
          this._desktopIconsUsableArea?.setMargins(
            p.monitor.index,
            0,
            0,
            p.geom.outerSize,
            0,
          )
          break
        case St.Side.RIGHT:
          this._desktopIconsUsableArea?.setMargins(
            p.monitor.index,
            0,
            0,
            0,
            p.geom.outerSize,
          )
          break
      }
    })
  }

  setFocusedMonitor(monitor) {
    this.focusedMonitorPanel = this.allPanels.find((p) => p.monitor == monitor)

    if (!this.checkIfFocusedMonitor(monitor)) {
      // 在 USE_SAFE_DEFAULTS_CONFLICTING 模式下，跳过修改全局 overview 和 primaryMonitor
      // 这些修改可能会与 Dash to Panel 冲突
      if (!USE_SAFE_DEFAULTS_CONFLICTING) {
        Main.overview._overview.clear_constraints()
        Main.overview._overview.add_constraint(
          new Layout.MonitorConstraint({ index: monitor.index }),
        )

        Main.overview._overview._controls._workspacesDisplay._primaryIndex =
          monitor.index

        // https://gitlab.gnome.org/GNOME/gnome-shell/-/merge_requests/2395
        // The overview allocation used to calculate its workarea based on the monitor where the overview
        // was displayed, but it got changed back to always use the primary monitor. So now, temporarily assign
        // the primary monitor to dtp focused monitor while recalculating the overview workarea
        Main.layoutManager.primaryMonitor = monitor
        Main.overview._overview._controls.layout_manager._updateWorkAreaBox()
        Main.layoutManager.primaryMonitor =
          Main.layoutManager.monitors[Main.layoutManager.primaryIndex]
      }
    }
  }

  showFocusedAppInOverview(app, keepOverviewOpen) {
    if (app == this.focusedApp) {
      if (!keepOverviewOpen && Main.overview._shown) Main.overview.hide()

      return
    }

    let isolateWorkspaces = USE_SAFE_DEFAULTS_CONFLICTING
      ? false
      : SETTINGS.get_boolean('isolate-workspaces')
    let isolateMonitors = USE_SAFE_DEFAULTS_CONFLICTING
      ? false
      : !SETTINGS.get_boolean('multi-monitors') ||
        SETTINGS.get_boolean('isolate-monitors')

    this.focusedApp = app

    if (!this._signalsHandler.hasLabel('overview-spread')) {
      let hasWorkspaces = Main.sessionMode.hasWorkspaces
      let maybeDisableWorkspacesClick = () => {
        if (!isolateWorkspaces)
          Utils.getOverviewWorkspaces().forEach(
            (w) => (w._container.get_actions()[0].enabled = false),
          )
      }
      let isIncludedWindow = (metaWindow) =>
        !this.focusedApp ||
        tracker.get_window_app(metaWindow) == this.focusedApp

      Main.sessionMode.hasWorkspaces = isolateWorkspaces
      maybeDisableWorkspacesClick()

      Workspace.prototype._oldIsMyWindow = Workspace.prototype._isMyWindow
      Workspace.prototype._isMyWindow = function (metaWindow) {
        if (!metaWindow) return false

        return (
          isIncludedWindow(metaWindow) &&
          (this.metaWorkspace === null ||
            (!isolateWorkspaces && this.metaWorkspace.active) ||
            (isolateWorkspaces &&
              metaWindow.located_on_workspace(this.metaWorkspace))) &&
          (!isolateMonitors || metaWindow.get_monitor() === this.monitorIndex)
        )
      }

      this.focusedWorkspace = !isolateWorkspaces
        ? Utils.getCurrentWorkspace()
        : null

      this._signalsHandler.addWithLabel(
        'overview-spread',
        [Main.overview, 'showing', maybeDisableWorkspacesClick],
        [
          Main.overview,
          'hidden',
          () => {
            Utils.getCurrentWorkspace()
              .list_windows()
              .forEach((w) => {
                if (
                  !w.minimized &&
                  !w.customJS_ding &&
                  global.display.focus_window != w &&
                  tracker.get_window_app(w) != this.focusedApp
                ) {
                  let window = w.get_compositor_private()

                  ;(window.get_first_child() || window).opacity = 0

                  Utils.animateWindowOpacity(window, {
                    opacity: 255,
                    time: 0.25,
                    transition: 'easeOutQuad',
                  })
                }
              })

            this.focusedApp = null
            this.focusedWorkspace = null
            this._signalsHandler.removeWithLabel('overview-spread')

            Main.sessionMode.hasWorkspaces = hasWorkspaces

            Workspace.prototype._isMyWindow = Workspace.prototype._oldIsMyWindow
            delete Workspace.prototype._oldIsMyWindow
          },
        ],
      )
    }

    if (Main.overview._shown) {
      Utils.getOverviewWorkspaces().forEach((w) => {
        let metaWindows = []
        let metaWorkspace =
          w.metaWorkspace ||
          Utils.DisplayWrapper.getWorkspaceManager().get_active_workspace()

        w._container.layout_manager._windows.forEach((info, preview) =>
          preview.destroy(),
        )

        if (this.focusedWorkspace && this.focusedWorkspace == metaWorkspace)
          metaWindows = Utils.getAllMetaWindows()
        else if (!this.focusedWorkspace)
          metaWindows = metaWorkspace.list_windows()

        metaWindows.forEach((mw) => w._doAddWindow(mw))
      })
    } else Main.overview.show()
  }

  _newSetPrimaryWorkspaceVisible(visible) {
    if (this._primaryVisible === visible) return

    this._primaryVisible = visible

    const primaryIndex =
      Main.overview._overview._controls._workspacesDisplay._primaryIndex
    const primaryWorkspace = this._workspacesViews[primaryIndex]
    if (primaryWorkspace) primaryWorkspace.visible = visible
  }

  _newUpdateWorkspacesViews() {
    for (let i = 0; i < this._workspacesViews.length; i++)
      this._workspacesViews[i].destroy()

    this._workspacesViews = []
    let monitors = Main.layoutManager.monitors
    for (let i = 0; i < monitors.length; i++) {
      let view
      if (i === this._primaryIndex) {
        view = new WorkspacesView(
          i,
          this._controls,
          this._scrollAdjustment,
          this._fitModeAdjustment,
          this._overviewAdjustment,
        )

        view.visible = this._primaryVisible
        this.bind_property(
          'opacity',
          view,
          'opacity',
          GObject.BindingFlags.SYNC_CREATE,
        )
        this.add_child(view)
      } else {
        // No idea why atm, but we need the import at the top of this file and to use the
        // full imports ns here, otherwise SecondaryMonitorDisplay can't be used ¯\_(ツ)_/¯
        view = new SecondaryMonitorDisplay(
          i,
          this._controls,
          this._scrollAdjustment,
          this._fitModeAdjustment,
          this._overviewAdjustment,
        )
        Main.layoutManager.overviewGroup.add_child(view)
      }

      this._workspacesViews.push(view)
    }
  }

  checkIfFocusedMonitor(monitor) {
    const wsDisplay = ShellCompat.getWorkspacesDisplay()
    return wsDisplay?._primaryIndex == monitor.index
  }

  _createPanel(monitor, isStandalone) {
    let panelBox
    let panel
    let clipContainer = new Clutter.Actor()

    if (isStandalone) {
      panelBox = new Utils.createBoxLayout({ name: 'panelBox' })
    } else {
      panelBox = Main.layoutManager.panelBox
      Main.layoutManager._untrackActor(panelBox)
      panelBox.remove_child(Main.panel)
      Main.layoutManager.removeChrome(panelBox)
    }

    // clipContainer 只是裁剪/定位容器：
    // - work area/struts 由 panelBox（trackChrome affectsStruts: true）提供
    // - intellihide 显示/隐藏时会动态关闭/开启 struts（见 intellihide._setTrackPanel）
    ShellCompat.addLayoutChrome(clipContainer, { reactive: false })
    clipContainer.add_child(panelBox)

    panel = new Panel.Panel(
      this,
      monitor,
      clipContainer,
      panelBox,
      isStandalone,
    )
    panelBox.add_child(panel)
    panel.enable()

    panelBox._dtpIndex = monitor.index
    panelBox.set_position(0, 0)
    panelBox.set_width(-1)

    ShellCompat.trackLayoutChrome(panel, { affectsStruts: false })

    ShellCompat.trackLayoutChrome(panelBox, {
      trackFullscreen: true,
      affectsStruts: true,
    })

    // intellihide changes the chrome when enabled, so init after setting initial chrome params
    panel.intellihide.init()

    this._findPanelMenuButtons(panelBox).forEach((pmb) =>
      this._adjustPanelMenuButton(pmb, monitor, panel.geom.position),
    )

    panel.taskbar.iconAnimator.start()

    return panel
  }

  _reset() {
    this.disable(true)
    this.allPanels = []
    this.enable(true)
  }

  _updatePanelElementPositions() {
    this.allPanels.forEach((p) => p.updateElementPositions())
  }

  _adjustPanelMenuButton(button, monitor, arrowSide) {
    if (button) {
      button.menu._boxPointer._dtpSourceActor =
        button.menu._boxPointer.sourceActor
      button.menu._boxPointer.sourceActor = button
      button.menu._boxPointer._userArrowSide = arrowSide
      button.menu._boxPointer._dtpInPanel = 1

      if (!button.menu._boxPointer.vfunc_get_preferred_height) {
        button.menu._boxPointer._dtpGetPreferredHeightId =
          button.menu._boxPointer._container.connect(
            'get-preferred-height',
            (actor, forWidth, alloc) => {
              this._getBoxPointerPreferredHeight(
                button.menu._boxPointer,
                alloc,
                monitor,
              )
            },
          )
      }
    }
  }

  _getBoxPointerPreferredHeight(boxPointer, alloc, monitor) {
    if (
      boxPointer._dtpInPanel &&
      boxPointer.sourceActor &&
      SETTINGS.get_boolean('intellihide')
    ) {
      monitor =
        monitor ||
        Main.layoutManager.findMonitorForActor(boxPointer.sourceActor)
      let panel = Utils.find(
        global.workspacesToDock.panels,
        (p) => p.monitor == monitor,
      )
      let excess = alloc.natural_size + panel.outerSize + 10 - monitor.height // 10 is arbitrary

      if (excess > 0) {
        alloc.natural_size -= excess
      }
    }

    return [alloc.min_size, alloc.natural_size]
  }

  _findPanelMenuButtons(container) {
    let panelMenuButtons = []
    let panelMenuButton

    let find = (parent) =>
      parent.get_children().forEach((c) => {
        if ((panelMenuButton = this._getPanelMenuButton(c))) {
          panelMenuButtons.push(panelMenuButton)
        }

        find(c)
      })

    find(container)

    return panelMenuButtons
  }

  _removePanelBarriers(panel) {
    if (panel.isStandalone && panel._rightPanelBarrier) {
      panel._rightPanelBarrier.destroy()
    }

    if (panel._leftPanelBarrier) {
      panel._leftPanelBarrier.destroy()
      delete panel._leftPanelBarrier
    }
  }

  _getPanelMenuButton(obj) {
    return obj instanceof PanelMenu.Button && obj.menu?._boxPointer ? obj : 0
  }

  _setKeyBindings(enable) {
    let keys = {
      'intellihide-key-toggle': () =>
        this.allPanels.forEach((p) => p.intellihide.toggle()),
    }

    Object.keys(keys).forEach((k) => {
      Utils.removeKeybinding(k)

      if (enable) {
        Utils.addKeybinding(k, SETTINGS, keys[k], Shell.ActionMode.NORMAL)
      }
    })
  }
}

// This class drives long-running icon animations, to keep them running in sync
// with each other.
export const IconAnimator = class {
  constructor(actor) {
    this._count = 0
    this._started = false
    this._animations = {
      dance: [],
    }
    this._timeline = new Clutter.Timeline({
      duration: 3000,
      repeat_count: -1,
    })

    /* Just use the construction property when no need to support 3.36 */
    if (this._timeline.set_actor) this._timeline.set_actor(actor)

    this._timeline.connect('new-frame', () => {
      const progress = this._timeline.get_progress()
      const danceRotation =
        progress < 1 / 6 ? 15 * Math.sin(progress * 24 * Math.PI) : 0
      const dancers = this._animations.dance
      for (let i = 0, iMax = dancers.length; i < iMax; i++) {
        dancers[i].target.rotation_angle_z = danceRotation
      }
    })
  }

  destroy() {
    this._timeline.stop()
    this._timeline = null
    for (let name in this._animations) {
      const pairs = this._animations[name]
      for (let i = 0, iMax = pairs.length; i < iMax; i++) {
        const pair = pairs[i]
        pair.target.disconnect(pair.targetDestroyId)
      }
    }
    this._animations = null
  }

  pause() {
    if (this._started && this._count > 0) {
      this._timeline.stop()
    }
    this._started = false
  }

  start() {
    if (!this._started && this._count > 0) {
      this._timeline.start()
    }
    this._started = true
  }

  addAnimation(target, name) {
    // before adding a new animation, remove previous one to only have one running
    let animationNames = Object.keys(this._animations)

    for (let i = 0; i < animationNames.length; ++i) {
      let n = animationNames[i]
      let currentAnimationPair = this._animations[n].find(
        (p) => p.target == target,
      )

      if (currentAnimationPair) {
        if (n == name) return // already have this animation running, nothing else to do

        this.removeAnimation(currentAnimationPair.target, n)
      }
    }

    const targetDestroyId = target.connect('destroy', () =>
      this.removeAnimation(target, name),
    )
    this._animations[name].push({
      target: target,
      targetDestroyId: targetDestroyId,
    })
    if (this._started && this._count === 0) {
      this._timeline.start()
    }
    this._count++
  }

  removeAnimation(target, name) {
    const pairs = this._animations[name]
    for (let i = 0, iMax = pairs.length; i < iMax; i++) {
      const pair = pairs[i]
      if (pair.target === target) {
        target.disconnect(pair.targetDestroyId)
        pairs.splice(i, 1)
        this._count--
        if (this._started && this._count === 0) {
          this._timeline.stop()
        }

        if (name == 'dance') target.rotation_angle_z = 0

        return
      }
    }
  }
}
