/*
 * GNOME Shell / Mutter compatibility helpers (GS 49–50+).
 * Centralizes API differences so runtime code does not scatter version checks.
 */

import Meta from 'gi://Meta'
import * as Config from 'resource:///org/gnome/shell/misc/config.js'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'

/** Mutter 50 removed X11; missing API means Wayland-only session. */
export function isWaylandCompositor() {
  return typeof Meta.is_wayland_compositor !== 'function'
    ? true
    : Meta.is_wayland_compositor()
}

export function getOverviewControls() {
  try {
    return Main.overview?._overview?._controls ?? null
  } catch (e) {
    return null
  }
}

export function getWorkspacesDisplay() {
  return getOverviewControls()?._workspacesDisplay ?? null
}

export function getOverviewWorkspaces() {
  const display = getWorkspacesDisplay()
  if (!display?._workspacesViews) return []

  return display._workspacesViews.flatMap((wv) => [
    ...(wv._workspaces || []),
    ...(wv._workspacesView?._workspaces || []),
    ...(wv._workspacesView?._workspace ? [wv._workspacesView._workspace] : []),
  ])
}

/**
 * GS 50 removed affectsInputRegion from LayoutManager chrome params.
 * Use reactive:false on passive containers instead.
 */
export function addLayoutChrome(actor, { reactive = true } = {}) {
  if (!reactive) {
    actor.reactive = false
    actor.track_hover = false
  }
  Main.layoutManager.addChrome(actor)
}

export function trackLayoutChrome(actor, params = {}) {
  const { affectsInputRegion: _drop, ...rest } = params
  Main.layoutManager.trackChrome(actor, rest)
}

export function shellMajorVersion() {
  const v = parseInt(Config.PACKAGE_VERSION, 10)
  return Number.isFinite(v) ? v : 0
}

export function supportsPressureBarriers() {
  const barriers = Meta.BackendCapabilities?.BARRIERS
  return (
    barriers &&
    global.backend?.capabilities &&
    (global.backend.capabilities & barriers) === barriers
  )
}
