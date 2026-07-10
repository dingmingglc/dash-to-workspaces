/*
 * Notification badge / intellihide notify handling for taskbar app icons.
 */

import { Hold } from '../intellihide.js'
import { SETTINGS } from '../extension.js'

export function handleAppNotifications(appIcon) {
  if (!appIcon._nWindows && !appIcon.window) return

  let monitor = appIcon.dtpPanel.panelManager.notificationsMonitor
  if (!monitor) return

  let state = monitor.getState(appIcon.app)
  let count = 0

  if (!state) return

  if (SETTINGS.get_boolean('progress-show-count')) {
    appIcon.iconAnimator[`${state.urgent ? 'add' : 'remove'}Animation`](
      appIcon.icon._iconBin,
      'dance',
    )

    if (state.total) {
      count = state.total > 9 ? '9+' : state.total
      appIcon.dtpPanel.intellihide.revealAndHold(Hold.NOTIFY)
    } else {
      appIcon.dtpPanel.intellihide.release(Hold.NOTIFY)
    }
  }

  appIcon._notificationsCount = count
  appIcon._maybeUpdateNumberOverlay()
}
