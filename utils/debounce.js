/*
 * Shared debounce helper (intellihide, proximity, etc.).
 */

export class DebouncedQueue {
  constructor(timeoutsHandler, timeoutName, intervalMs, callback) {
    this._timeoutsHandler = timeoutsHandler
    this._timeoutName = timeoutName
    this._intervalMs = intervalMs
    this._callback = callback
    this._pending = false
  }

  queue(immediate = false) {
    if (!immediate && this._timeoutsHandler.getId(this._timeoutName)) {
      this._pending = true
      return
    }

    this._timeoutsHandler.add([
      this._timeoutName,
      this._intervalMs,
      () => this._flush(),
    ])

    if (immediate) this._flush()
  }

  _flush() {
    if (this._pending) {
      this._pending = false
      this.queue()
      return
    }
    this._callback()
  }
}
