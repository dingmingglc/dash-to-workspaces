/*
 * Shared panel edge / pointer region math for intellihide and related code.
 */

import St from 'gi://St'

export function isVerticalPanel(position) {
  return position === St.Side.LEFT || position === St.Side.RIGHT
}

/** Stage-coordinate box from panel geometry (fallback before allocate). */
export function allocationFromGeom(geom) {
  if (!geom) return null
  return {
    x1: geom.x,
    y1: geom.y,
    x2: geom.x + geom.w,
    y2: geom.y + geom.h,
  }
}

/**
 * Test whether stage coordinates (x, y) fall in the panel reveal/hover region.
 */
export function pointerInPanelRegion({
  geom,
  monitor,
  allocation,
  varCoord,
  x,
  y,
  fixedOffset,
  limitToPanelLength,
  settings,
  limitSizeKey,
}) {
  if (!geom || !monitor) return false

  let position = geom.position
  let varCoordX1 = monitor.x
  let varCoordY1 = monitor.y
  let varSizeX = monitor.width
  let varSizeY = monitor.height
  let varOffset = {}

  if (geom.vertical && geom.gsTopPanelHeight) {
    varCoordY1 = monitor.y + geom.gsTopPanelHeight
    varSizeY = Math.max(0, monitor.height - geom.gsTopPanelHeight)
  }

  if (geom.dockMode && limitToPanelLength && settings?.get_boolean(limitSizeKey)) {
    if (!allocation) allocation = allocationFromGeom(geom)
    if (!allocation) return false

    if (!geom.dynamic) {
      varCoordX1 = geom.x
      varCoordY1 = geom.y
      varOffset[varCoord.c2] = allocation[varCoord.c2] - allocation[varCoord.c1]
    } else {
      varOffset[varCoord.c1] = allocation[varCoord.c1]
      varOffset[varCoord.c2] = allocation[varCoord.c2]
    }
  }

  const onEdge =
    (position === St.Side.TOP && y <= monitor.y + fixedOffset) ||
    (position === St.Side.BOTTOM &&
      y >= monitor.y + monitor.height - fixedOffset) ||
    (position === St.Side.LEFT && x <= monitor.x + fixedOffset) ||
    (position === St.Side.RIGHT &&
      x >= monitor.x + monitor.width - fixedOffset)

  return (
    onEdge &&
    x >= varCoordX1 + (varOffset.x1 || 0) &&
    x < varCoordX1 + (varOffset.x2 || varSizeX) &&
    y >= varCoordY1 + (varOffset.y1 || 0) &&
    y < varCoordY1 + (varOffset.y2 || varSizeY)
  )
}
