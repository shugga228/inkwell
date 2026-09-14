import { PDFDocument, rgb } from 'pdf-lib'
import * as pdfjsLib from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc

const ui = {
  pdfInput: document.querySelector('#pdfInput'),
  blankPdfButton: document.querySelector('#blankPdfButton'),
  toolSelect: document.querySelector('#toolSelect'),
  toolButtons: document.querySelectorAll('[data-tool]'),
  penColor: document.querySelector('#penColor'),
  highlighterColor: document.querySelector('#highlighterColor'),
  penOpacity: document.querySelector('#penOpacity'),
  penOpacityValue: document.querySelector('#penOpacityValue'),
  penWidth: document.querySelector('#penWidth'),
  penWidthValue: document.querySelector('#penWidthValue'),
  highlighterOpacity: document.querySelector('#highlighterOpacity'),
  highlighterOpacityValue: document.querySelector('#highlighterOpacityValue'),
  highlighterWidth: document.querySelector('#highlighterWidth'),
  highlighterWidthValue: document.querySelector('#highlighterWidthValue'),
  eraserWidth: document.querySelector('#eraserWidth'),
  eraserWidthValue: document.querySelector('#eraserWidthValue'),
  smoothingEnabled: document.querySelector('#smoothingEnabled'),
  smoothingWeight: document.querySelector('#smoothingWeight'),
  weightValue: document.querySelector('#weightValue'),
  undoButton: document.querySelector('#undoButton'),
  redoButton: document.querySelector('#redoButton'),
  zoomOutButton: document.querySelector('#zoomOutButton'),
  zoomInButton: document.querySelector('#zoomInButton'),
  zoomValue: document.querySelector('#zoomValue'),
  exportButton: document.querySelector('#exportButton'),
  status: document.querySelector('#status'),
  documentViewport: document.querySelector('#documentViewport'),
  pages: document.querySelector('#pages'),
  cursorRing: document.querySelector('#cursorRing')
}

const state = {
  pdfBytes: null,
  pdfDoc: null,
  exportSupported: false,
  pageSizes: [],
  annotations: [],
  selection: null,
  selectionGesture: null,
  clipboardSelection: null,
  activeStroke: null,
  currentPointerId: null,
  scale: 2,
  zoom: 1,
  zoomAnchor: null,
  isPanning: false,
  panStart: null,
  defaultPenOpacity: 0.65,
  highlighterOpacity: 0.23,
  penWidth: 2.4,
  highlighterWidth: 14,
  history: [],
  historyIndex: -1,
  hasUnexportedChanges: false
}

const settingOutputs = [
  ['penOpacity', 'penOpacityValue', (value) => `${Math.round(Number(value) * 100)}%`],
  ['penWidth', 'penWidthValue', (value) => value],
  ['highlighterOpacity', 'highlighterOpacityValue', (value) => `${Math.round(Number(value) * 100)}%`],
  ['highlighterWidth', 'highlighterWidthValue', (value) => value],
  ['eraserWidth', 'eraserWidthValue', (value) => value],
  ['smoothingWeight', 'weightValue', (value) => value]
]

settingOutputs.forEach(([inputId, outputId, format]) => {
  ui[inputId].addEventListener('input', () => {
    ui[outputId].value = format(ui[inputId].value)
    updateCanvasCursors()
  })
})

ui.undoButton.addEventListener('click', undo)
ui.redoButton.addEventListener('click', redo)
ui.blankPdfButton.addEventListener('click', createBlankPdf)
ui.zoomOutButton.addEventListener('click', () => setZoom(state.zoom - 0.25))
ui.zoomInButton.addEventListener('click', () => setZoom(state.zoom + 0.25))
ui.toolButtons.forEach((button) => {
  button.addEventListener('click', () => {
    cancelActiveGesture()
    ui.toolSelect.value = button.dataset.tool
    ui.toolButtons.forEach((toolButton) => {
      const isActive = toolButton === button
      toolButton.classList.toggle('is-active', isActive)
      toolButton.setAttribute('aria-pressed', String(isActive))
    })
    updateCanvasCursors()
  })
})

ui.documentViewport.addEventListener('pointerdown', (event) => {
  if (event.button !== 1) return

  state.isPanning = true
  state.panStart = {
    x: event.clientX,
    y: event.clientY,
    scrollLeft: ui.documentViewport.scrollLeft,
    scrollTop: ui.documentViewport.scrollTop
  }
  ui.documentViewport.setPointerCapture(event.pointerId)
  event.preventDefault()
})

ui.documentViewport.addEventListener('pointermove', (event) => {
  state.zoomAnchor = { x: event.clientX, y: event.clientY }

  if (!state.isPanning || !state.panStart) return

  ui.documentViewport.scrollLeft = state.panStart.scrollLeft - (event.clientX - state.panStart.x)
  ui.documentViewport.scrollTop = state.panStart.scrollTop - (event.clientY - state.panStart.y)
  event.preventDefault()
})

const finishPan = (event) => {
  if (!state.isPanning) return
  state.isPanning = false
  state.panStart = null
  if (ui.documentViewport.hasPointerCapture(event.pointerId)) {
    ui.documentViewport.releasePointerCapture(event.pointerId)
  }
}

ui.documentViewport.addEventListener('pointerup', finishPan)
ui.documentViewport.addEventListener('pointercancel', finishPan)
ui.documentViewport.addEventListener('wheel', (event) => {
  if (!(event.ctrlKey || event.metaKey)) return

  event.preventDefault()
  setZoom(state.zoom + (event.deltaY < 0 ? 0.25 : -0.25), event)
}, { passive: false })

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && state.selection) {
    const { pageIndex, strokeIndexes } = state.selection
    state.clipboardSelection = structuredClone(strokeIndexes.map((index) => state.annotations[pageIndex][index]))
    event.preventDefault()
    return
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v' && state.clipboardSelection?.length) {
    pasteSelection()
    event.preventDefault()
    return
  }

  if (event.key === 'Delete' && state.selection) {
    deleteSelection()
    event.preventDefault()
    return
  }

  if (!(event.ctrlKey || event.metaKey)) return

  if (event.key.toLowerCase() === 'z') {
    event.preventDefault()
    event.shiftKey ? redo() : undo()
  } else if (event.key === '+' || event.key === '=') {
    event.preventDefault()
    setZoom(state.zoom + 0.25)
  } else if (event.key === '-') {
    event.preventDefault()
    setZoom(state.zoom - 0.25)
  }
})

ui.pdfInput.addEventListener('change', async (event) => {
  const [file] = event.target.files ?? []
  if (!file) {
    return
  }

  try {
    await loadDocument(new Uint8Array(await file.arrayBuffer()), `loaded: ${file.name}`)
  } catch (error) {
    ui.status.textContent = `failed to load pdf: ${errorMessage(error)}`
  }
})

window.addEventListener('beforeunload', (event) => {
  if (!state.hasUnexportedChanges) return
  event.preventDefault()
  event.returnValue = 'All progress on this PDF will be lost if it is not exported.'
})

ui.exportButton.addEventListener('click', async () => {
  if (!state.pdfBytes || !state.exportSupported) {
    ui.status.textContent = 'this pdf cannot be exported by the current export engine.'
    return
  }

  ui.exportButton.disabled = true
  ui.status.textContent = 'exporting…'

  try {
    const output = await exportPdfWithAnnotations()
    const blob = new Blob([output], { type: 'application/pdf' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'annotated.pdf'
    link.click()
    URL.revokeObjectURL(url)
    state.hasUnexportedChanges = false
    ui.status.textContent = 'export complete.'
  } catch (error) {
    ui.status.textContent = `export failed: ${errorMessage(error)}`
  } finally {
    ui.exportButton.disabled = false
  }
})

async function checkExportCompatibility(bytes) {
  try {
    await PDFDocument.load(bytes)
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      message: errorMessage(error)
    }
  }
}

async function loadDocument(bytes, statusText, annotations = null) {
  state.pdfBytes = bytes
  state.exportSupported = false
  state.annotations = annotations ?? []
  state.selection = null
  state.selectionGesture = null
  state.clipboardSelection = null
  state.history = []
  state.historyIndex = -1
  state.hasUnexportedChanges = true
  ui.exportButton.disabled = true

  await loadAndRenderPdf(bytes, annotations)

  const compatibility = await checkExportCompatibility(bytes)
  state.exportSupported = compatibility.ok
  if (compatibility.ok) {
    ui.status.textContent = statusText
    ui.exportButton.disabled = false
    return
  }

  ui.status.textContent = `${statusText}. export unavailable: ${compatibility.message}`
}

async function createBlankPdf() {
  try {
    const pdfDoc = await PDFDocument.create()
    pdfDoc.addPage([612, 792])
    await loadDocument(await pdfDoc.save(), 'created blank pdf')
  } catch (error) {
    ui.status.textContent = `failed to create pdf: ${errorMessage(error)}`
  }
}

async function addPageAfter(pageIndex) {
  if (!state.pdfBytes) return

  try {
    const pdfDoc = await PDFDocument.load(state.pdfBytes)
    const currentPage = pdfDoc.getPage(pageIndex)
    pdfDoc.insertPage(pageIndex + 1, [currentPage.getWidth(), currentPage.getHeight()])
    const annotations = state.annotations.slice()
    annotations.splice(pageIndex + 1, 0, [])
    await loadDocument(await pdfDoc.save(), `added page ${pageIndex + 2}`, annotations)
  } catch (error) {
    ui.status.textContent = `failed to add page: ${errorMessage(error)}`
  }
}

async function removePage(pageIndex) {
  if (!state.pdfBytes || state.pageSizes.length <= 1) return

  try {
    const pdfDoc = await PDFDocument.load(state.pdfBytes)
    pdfDoc.removePage(pageIndex)
    const annotations = state.annotations.slice()
    annotations.splice(pageIndex, 1)
    await loadDocument(await pdfDoc.save(), `removed page ${pageIndex + 1}`, annotations)
  } catch (error) {
    ui.status.textContent = `failed to remove page: ${errorMessage(error)}`
  }
}

async function loadAndRenderPdf(bytes, existingAnnotations = null) {
  ui.pages.replaceChildren()

  const loadingTask = pdfjsLib.getDocument({ data: bytes.slice() })
  state.pdfDoc = await loadingTask.promise
  state.pageSizes = []

  for (let pageNumber = 1; pageNumber <= state.pdfDoc.numPages; pageNumber += 1) {
    const page = await state.pdfDoc.getPage(pageNumber)
    const viewport = page.getViewport({ scale: state.scale })

    const baseCanvas = document.createElement('canvas')
    baseCanvas.width = viewport.width
    baseCanvas.height = viewport.height

    const annotationCanvas = document.createElement('canvas')
    annotationCanvas.width = viewport.width
    annotationCanvas.height = viewport.height
    annotationCanvas.className = 'annotation-layer'

    const wrapper = document.createElement('div')
    wrapper.className = 'page'
    const controls = document.createElement('div')
    controls.className = 'page-controls'
    controls.innerHTML = `<span>page ${pageNumber}</span><button type="button" title="add a blank page after this page">+ page</button><button type="button" title="remove this page">remove</button>`
    const addButton = controls.querySelectorAll('button')[0]
    const removeButton = controls.querySelectorAll('button')[1]
    addButton.addEventListener('click', () => addPageAfter(pageNumber - 1))
    removeButton.addEventListener('click', () => removePage(pageNumber - 1))
    removeButton.disabled = state.pdfDoc.numPages === 1
    wrapper.append(baseCanvas, annotationCanvas)
    wrapper.append(controls)

    ui.pages.append(wrapper)

    const context = baseCanvas.getContext('2d')
    await page.render({ canvasContext: context, viewport }).promise

    setupDrawing(annotationCanvas, pageNumber - 1)
    state.annotations[pageNumber - 1] = existingAnnotations?.[pageNumber - 1] ?? []
    state.pageSizes[pageNumber - 1] = {
      canvasWidth: viewport.width,
      canvasHeight: viewport.height,
      pdfWidth: page.view[2],
      pdfHeight: page.view[3]
    }
  }

  state.history = [structuredClone(state.annotations)]
  state.historyIndex = 0
  updateHistoryButtons()
  updateCanvasCursors()
}

function setupDrawing(canvas, pageIndex) {
  const ctx = canvas.getContext('2d')

  canvas.addEventListener('pointerenter', () => {
    state.cursorCanvas = canvas
    updateCursorRingSize()
    ui.cursorRing.classList.add('is-visible')
  })

  canvas.addEventListener('pointermove', (event) => {
    state.cursorCanvas = canvas
    updateCursorRingSize()
    ui.cursorRing.style.left = `${event.clientX}px`
    ui.cursorRing.style.top = `${event.clientY}px`
    ui.cursorRing.classList.add('is-visible')
  })

  canvas.addEventListener('pointerleave', () => {
    if (!state.activeStroke) {
      ui.cursorRing.classList.remove('is-visible')
    }
  })

  canvas.onpointerdown = (event) => {
    if (event.button !== 0) {
      return
    }

    canvas.setPointerCapture(event.pointerId)
    state.currentPointerId = event.pointerId

    const point = pointFromEvent(event, canvas)
    const tool = ui.toolSelect.value

    if (tool === 'select') {
      beginSelectionGesture(event, canvas, pageIndex, point)
      return
    }

    if (tool === 'eraser') {
      state.activeStroke = { pageIndex, tool, points: [point], changed: false }
      eraseAtPoint(pageIndex, point)
      event.preventDefault()
      return
    }

    const opacity = resolveOpacity(event, tool)

    state.activeStroke = {
      pageIndex,
      tool,
      color: tool === 'pen' ? ui.penColor.value : ui.highlighterColor.value,
      width: tool === 'pen' ? Number(ui.penWidth.value) : Number(ui.highlighterWidth.value),
      opacity: tool === 'pen' ? Number(ui.penOpacity.value) : Number(ui.highlighterOpacity.value),
      points: [
        {
          ...point,
          opacity
        }
      ],
      smoothedPoint: point
    }

    event.preventDefault()
  }

  canvas.onpointermove = (event) => {
    if (state.selectionGesture && state.currentPointerId === event.pointerId) {
      updateSelectionGesture(event, canvas)
      return
    }

    if (!state.activeStroke || state.currentPointerId !== event.pointerId) {
      return
    }

    const nextPoint = pointFromEvent(event, canvas)

    if (state.activeStroke.tool === 'eraser') {
      eraseAtPoint(pageIndex, nextPoint)
      state.activeStroke.points.push(nextPoint)
      event.preventDefault()
      return
    }

    const opacity = resolveOpacity(event, state.activeStroke.tool)

    const finalPoint = ui.smoothingEnabled.checked
      ? smoothPoint(nextPoint, state.activeStroke.smoothedPoint, Number(ui.smoothingWeight.value))
      : nextPoint

    state.activeStroke.smoothedPoint = finalPoint

    const previous = state.activeStroke.points[state.activeStroke.points.length - 1]
    const pointWithOpacity = { ...finalPoint, opacity }

    drawSegment(ctx, state.activeStroke, previous, pointWithOpacity)
    state.activeStroke.points.push(pointWithOpacity)

    event.preventDefault()
  }

  const finishStroke = (event) => {
    if (state.selectionGesture && state.currentPointerId === event.pointerId) {
      finishSelectionGesture(event, canvas)
      return
    }

    if (!state.activeStroke || state.currentPointerId !== event.pointerId) {
      return
    }

    const stroke = state.activeStroke
    if (stroke.tool === 'eraser') {
      if (stroke.changed) {
        commitHistory()
      }
    } else {
      state.annotations[stroke.pageIndex].push({
        tool: stroke.tool,
        color: stroke.color,
        width: stroke.width,
        opacity: stroke.opacity,
        points: stroke.points
      })
      commitHistory()
    }

    state.activeStroke = null
    state.currentPointerId = null

    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId)
    }

    event.preventDefault()
  }

  canvas.onpointerup = finishStroke
  canvas.onpointercancel = finishStroke
}

function beginSelectionGesture(event, canvas, pageIndex, point) {
  const selection = state.selection?.pageIndex === pageIndex ? state.selection : null
  const handle = selection ? selectionHandleAt(selection.bounds, point) : null
  let type = 'marquee'

  if (handle === 'rotate') type = 'rotate'
  else if (handle) type = `resize-${handle}`
  else if (selection && pointInBounds(point, selection.bounds)) type = 'move'

  const originalStrokes = selection
    ? selection.strokeIndexes.map((index) => structuredClone(state.annotations[pageIndex][index]))
    : []

  state.selectionGesture = {
    type,
    pageIndex,
    start: point,
    originalSelection: selection ? structuredClone(selection) : null,
    originalStrokes
  }
  state.currentPointerId = event.pointerId
  canvas.setPointerCapture(event.pointerId)

  if (type === 'marquee') {
    state.selection = null
    renderSelectionOverlay()
  }
  event.preventDefault()
}

function updateSelectionGesture(event, canvas) {
  const gesture = state.selectionGesture
  const point = pointFromEvent(event, canvas)

  if (gesture.type === 'marquee') {
    state.selection = {
      pageIndex: gesture.pageIndex,
      strokeIndexes: [],
      bounds: boundsFromPoints([gesture.start, point])
    }
    renderSelectionOverlay(true)
    event.preventDefault()
    return
  }

  const selection = gesture.originalSelection
  if (!selection) return

  const transformed = gesture.originalStrokes.map((stroke) => ({
    ...stroke,
    points: stroke.points.map((strokePoint) => transformSelectionPoint(
      strokePoint,
      selection.bounds,
      gesture.start,
      point,
      gesture.type
    ))
  }))
  clampStrokesToCanvas(transformed, canvas.width, canvas.height)
  transformed.forEach((stroke, index) => {
    state.annotations[gesture.pageIndex][selection.strokeIndexes[index]] = stroke
  })
  state.selection = {
    ...selection,
    bounds: selectionBounds(transformed)
  }
  redrawPage(gesture.pageIndex)
  renderSelectionOverlay()
  event.preventDefault()
}

function cancelActiveGesture() {
  const pointerId = state.currentPointerId
  const gesture = state.selectionGesture
  if (gesture?.type !== 'marquee' && gesture?.originalSelection
    && selectionChanged(gesture.originalSelection, state.selection)) {
    commitHistory()
  }

  if (pointerId !== null) {
    document.querySelectorAll('canvas').forEach((canvas) => {
      releasePointerCapture(canvas, pointerId)
    })
  }

  state.activeStroke = null
  state.selectionGesture = null
  state.currentPointerId = null
  state.isPanning = false
  state.panStart = null
}

function releasePointerCapture(element, pointerId) {
  if (!element.hasPointerCapture?.(pointerId)) return
  try {
    element.releasePointerCapture(pointerId)
  } catch {}
}

function finishSelectionGesture(event, canvas) {
  const gesture = state.selectionGesture
  const point = pointFromEvent(event, canvas)

  if (gesture.type === 'marquee') {
    const bounds = boundsFromPoints([gesture.start, point])
    const strokes = state.annotations[gesture.pageIndex]
    const strokeIndexes = strokes
      .map((stroke, index) => ({ stroke, index }))
      .filter(({ stroke }) => boundsOverlap(bounds, selectionBounds([stroke])))
      .map(({ index }) => index)
    state.selection = strokeIndexes.length
      ? { pageIndex: gesture.pageIndex, strokeIndexes, bounds: selectionBounds(strokeIndexes.map((index) => strokes[index])) }
      : null
  } else if (gesture.originalSelection && selectionChanged(gesture.originalSelection, state.selection)) {
    commitHistory()
  }

  state.selectionGesture = null
  state.currentPointerId = null
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
  renderSelectionOverlay()
  event.preventDefault()
}

function selectionHandleAt(bounds, point) {
  const tolerance = Math.max(12, Math.min(bounds.width, bounds.height) * 0.08)
  const rotatePoint = { x: bounds.x + bounds.width / 2, y: bounds.y - 24 }
  if (Math.hypot(point.x - rotatePoint.x, point.y - rotatePoint.y) <= tolerance) return 'rotate'

  const corners = {
    nw: { x: bounds.x, y: bounds.y },
    ne: { x: bounds.x + bounds.width, y: bounds.y },
    sw: { x: bounds.x, y: bounds.y + bounds.height },
    se: { x: bounds.x + bounds.width, y: bounds.y + bounds.height }
  }
  for (const [name, corner] of Object.entries(corners)) {
    if (Math.hypot(point.x - corner.x, point.y - corner.y) <= tolerance) return name
  }
  return null
}

function pointInBounds(point, bounds) {
  return point.x >= bounds.x && point.x <= bounds.x + bounds.width
    && point.y >= bounds.y && point.y <= bounds.y + bounds.height
}

function boundsFromPoints(points) {
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const left = Math.min(...xs)
  const top = Math.min(...ys)
  return {
    x: left,
    y: top,
    width: Math.max(1, Math.max(...xs) - left),
    height: Math.max(1, Math.max(...ys) - top)
  }
}

function selectionBounds(strokes) {
  const points = strokes.flatMap((stroke) => stroke.points)
  return boundsFromPoints(points)
}

function boundsOverlap(first, second) {
  return first.x <= second.x + second.width
    && first.x + first.width >= second.x
    && first.y <= second.y + second.height
    && first.y + first.height >= second.y
}

function transformSelectionPoint(point, bounds, start, current, type) {
  if (type === 'move') {
    return { x: point.x + current.x - start.x, y: point.y + current.y - start.y }
  }

  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
  if (type === 'rotate') {
    const startAngle = Math.atan2(start.y - center.y, start.x - center.x)
    const currentAngle = Math.atan2(current.y - center.y, current.x - center.x)
    return rotatePoint(point, center, currentAngle - startAngle)
  }

  const corner = type.replace('resize-', '')
  const anchor = {
    x: corner.includes('w') ? bounds.x + bounds.width : bounds.x,
    y: corner.includes('n') ? bounds.y + bounds.height : bounds.y
  }
  const scaleX = Math.max(0.05, Math.abs(current.x - anchor.x) / bounds.width)
  const scaleY = Math.max(0.05, Math.abs(current.y - anchor.y) / bounds.height)
  return {
    x: anchor.x + (point.x - anchor.x) * scaleX,
    y: anchor.y + (point.y - anchor.y) * scaleY
  }
}

function rotatePoint(point, center, angle) {
  const x = point.x - center.x
  const y = point.y - center.y
  const cosine = Math.cos(angle)
  const sine = Math.sin(angle)
  return {
    x: center.x + x * cosine - y * sine,
    y: center.y + x * sine + y * cosine
  }
}

function clampStrokesToCanvas(strokes, canvasWidth, canvasHeight) {
  const bounds = selectionBounds(strokes)
  const minShiftX = canvasWidth >= bounds.width ? -bounds.x : canvasWidth - bounds.x - bounds.width
  const maxShiftX = canvasWidth >= bounds.width ? canvasWidth - bounds.x - bounds.width : -bounds.x
  const minShiftY = canvasHeight >= bounds.height ? -bounds.y : canvasHeight - bounds.y - bounds.height
  const maxShiftY = canvasHeight >= bounds.height ? canvasHeight - bounds.y - bounds.height : -bounds.y
  const shiftX = clamp(0, minShiftX, maxShiftX)
  const shiftY = clamp(0, minShiftY, maxShiftY)

  if (!shiftX && !shiftY) return
  strokes.forEach((stroke) => {
    stroke.points.forEach((point) => {
      point.x += shiftX
      point.y += shiftY
    })
  })
}

function selectionChanged(original, current) {
  if (!current) return false
  return original.bounds.x !== current.bounds.x
    || original.bounds.y !== current.bounds.y
    || original.bounds.width !== current.bounds.width
    || original.bounds.height !== current.bounds.height
}

function renderSelectionOverlay(isPreview = false) {
  document.querySelectorAll('.selection-box').forEach((element) => element.remove())
  const selection = state.selection
  if (!selection || (!selection.strokeIndexes.length && !isPreview)) return

  const canvas = ui.pages.querySelectorAll('.annotation-layer')[selection.pageIndex]
  if (!canvas) return
  const box = document.createElement('div')
  box.className = 'selection-box'
  box.style.left = `${selection.bounds.x / canvas.width * 100}%`
  box.style.top = `${selection.bounds.y / canvas.height * 100}%`
  box.style.width = `${selection.bounds.width / canvas.width * 100}%`
  box.style.height = `${selection.bounds.height / canvas.height * 100}%`

  if (!isPreview) {
    ;['nw', 'ne', 'sw', 'se'].forEach((position) => {
      const handle = document.createElement('span')
      handle.className = `selection-handle ${position}`
      box.append(handle)
    })
    const rotateHandle = document.createElement('span')
    rotateHandle.className = 'selection-handle rotate'
    box.append(rotateHandle)
  }
  canvas.parentElement.append(box)
}

function deleteSelection() {
  const { pageIndex, strokeIndexes } = state.selection
  const indexes = new Set(strokeIndexes)
  state.annotations[pageIndex] = state.annotations[pageIndex].filter((_, index) => !indexes.has(index))
  state.selection = null
  redrawPage(pageIndex)
  commitHistory()
  renderSelectionOverlay()
}

function pasteSelection() {
  const pageIndex = state.selection?.pageIndex ?? 0
  const canvas = ui.pages.querySelectorAll('.annotation-layer')[pageIndex]
  const strokes = state.clipboardSelection.map((stroke) => ({
    ...stroke,
    points: stroke.points.map((point) => ({ ...point, x: point.x + 24, y: point.y + 24 }))
  }))
  if (canvas) clampStrokesToCanvas(strokes, canvas.width, canvas.height)
  const firstIndex = state.annotations[pageIndex].length
  state.annotations[pageIndex].push(...strokes)
  state.selection = {
    pageIndex,
    strokeIndexes: strokes.map((_, index) => firstIndex + index),
    bounds: selectionBounds(strokes)
  }
  redrawPage(pageIndex)
  commitHistory()
  renderSelectionOverlay()
}

function smoothPoint(nextPoint, previousSmoothedPoint, weight) {
  return {
    x: previousSmoothedPoint.x + (nextPoint.x - previousSmoothedPoint.x) * (1 - weight),
    y: previousSmoothedPoint.y + (nextPoint.y - previousSmoothedPoint.y) * (1 - weight)
  }
}

function drawSegment(ctx, stroke, from, to) {
  if (!from || !to) {
    return
  }

  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = stroke.color
  ctx.lineWidth = stroke.width
  ctx.globalAlpha = segmentOpacity(stroke.tool, from.opacity, to.opacity)
  ctx.beginPath()
  ctx.moveTo(from.x, from.y)
  ctx.lineTo(to.x, to.y)
  ctx.stroke()
  ctx.restore()
}

function resolveOpacity(event, tool) {
  const configuredOpacity = tool === 'highlighter'
    ? Number(ui.highlighterOpacity.value)
    : Number(ui.penOpacity.value)

  if (event.pressure && event.pressure > 0) {
    return clamp(event.pressure * configuredOpacity, 0.05, 1)
  }

  return configuredOpacity
}

function segmentOpacity(tool, fromOpacity, toOpacity) {
  return clamp((fromOpacity + toOpacity) / 2, 0.05, 1)
}

function eraseAtPoint(pageIndex, point) {
  const radius = Number(ui.eraserWidth.value) / 2
  const strokes = state.annotations[pageIndex]
  const remaining = []
  let didErase = false

  strokes.forEach((stroke) => {
    const eraseDistance = radius + stroke.width / 2
    let segment = []

    const flushSegment = () => {
      if (segment.length > 1) {
        remaining.push({ ...stroke, points: segment })
      }
      segment = []
    }

    stroke.points.forEach((strokePoint) => {
      if (Math.hypot(strokePoint.x - point.x, strokePoint.y - point.y) <= eraseDistance) {
        didErase = true
        flushSegment()
      } else {
        segment.push(strokePoint)
      }
    })

    flushSegment()
  })

  if (!didErase) return

  state.annotations[pageIndex] = remaining
  state.activeStroke.changed = true
  redrawPage(pageIndex)
}

function redrawPage(pageIndex) {
  const canvas = ui.pages.querySelectorAll('.annotation-layer')[pageIndex]
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  state.annotations[pageIndex].forEach((stroke) => {
    for (let index = 1; index < stroke.points.length; index += 1) {
      drawSegment(ctx, stroke, stroke.points[index - 1], stroke.points[index])
    }
  })
}

function commitHistory() {
  state.history = state.history.slice(0, state.historyIndex + 1)
  state.history.push(structuredClone(state.annotations))
  state.historyIndex = state.history.length - 1
  state.hasUnexportedChanges = true
  updateHistoryButtons()
}

function restoreHistory(index) {
  if (index < 0 || index >= state.history.length) return

  state.historyIndex = index
  state.annotations = structuredClone(state.history[index])
  state.hasUnexportedChanges = true
  state.annotations.forEach((_, pageIndex) => redrawPage(pageIndex))
  updateHistoryButtons()
}

function undo() {
  restoreHistory(state.historyIndex - 1)
}

function redo() {
  restoreHistory(state.historyIndex + 1)
}

function updateHistoryButtons() {
  ui.undoButton.disabled = state.historyIndex <= 0
  ui.redoButton.disabled = state.historyIndex >= state.history.length - 1
}

function setZoom(value, event = null) {
  const nextZoom = clamp(Number(value), 0.5, 3)
  if (nextZoom === state.zoom) return

  const viewportRect = ui.documentViewport.getBoundingClientRect()
  const anchor = event
    ? { x: event.clientX, y: event.clientY }
    : state.zoomAnchor ?? {
      x: viewportRect.left + viewportRect.width / 2,
      y: viewportRect.top + viewportRect.height / 2
    }
  const targetPage = document.elementFromPoint(anchor.x, anchor.y)?.closest('.page')
  const targetRect = targetPage?.getBoundingClientRect()
  const pagePoint = targetRect
    ? {
      x: (anchor.x - targetRect.left) / targetRect.width,
      y: (anchor.y - targetRect.top) / targetRect.height
    }
    : null

  state.zoom = nextZoom
  ui.pages.style.setProperty('--zoom', state.zoom)
  ui.zoomValue.value = `${Math.round(state.zoom * 100)}%`
  ui.zoomOutButton.disabled = state.zoom <= 0.5
  ui.zoomInButton.disabled = state.zoom >= 3

  if (targetPage && pagePoint) {
    const nextRect = targetPage.getBoundingClientRect()
    ui.documentViewport.scrollLeft += nextRect.left + nextRect.width * pagePoint.x - anchor.x
    ui.documentViewport.scrollTop += nextRect.top + nextRect.height * pagePoint.y - anchor.y
  }

  updateCanvasCursors()
}

function updateCanvasCursors() {
  updateCursorRingSize()
}

function updateCursorRingSize() {
  const tool = ui.toolSelect.value
  if (tool === 'select') {
    ui.cursorRing.classList.remove('is-visible')
    return
  }
  if (!state.cursorCanvas) return

  const width = tool === 'pen'
    ? Number(ui.penWidth.value)
    : tool === 'highlighter'
      ? Number(ui.highlighterWidth.value)
      : Number(ui.eraserWidth.value)

  const displayScale = state.cursorCanvas.clientWidth / state.cursorCanvas.width || 1
  const radius = Math.max(3, width * displayScale / 2)
  ui.cursorRing.style.width = `${radius * 2}px`
  ui.cursorRing.style.height = `${radius * 2}px`
}

function pointFromEvent(event, canvas) {
  const rect = canvas.getBoundingClientRect()
  return {
    x: (event.clientX - rect.left) * (canvas.width / rect.width),
    y: (event.clientY - rect.top) * (canvas.height / rect.height)
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function hexToRgb(hex) {
  const stripped = hex.replace('#', '')
  const value = Number.parseInt(stripped, 16)

  return rgb(
    ((value >> 16) & 255) / 255,
    ((value >> 8) & 255) / 255,
    (value & 255) / 255
  )
}

async function exportPdfWithAnnotations() {
  const pdfDoc = await PDFDocument.load(state.pdfBytes)
  const pages = pdfDoc.getPages()

  state.annotations.forEach((strokes, pageIndex) => {
    if (!strokes?.length) {
      return
    }

    const pdfPage = pages[pageIndex]
    const size = state.pageSizes[pageIndex]

    strokes.forEach((stroke) => {
      if (!stroke.points || stroke.points.length < 2) {
        return
      }

      for (let i = 1; i < stroke.points.length; i += 1) {
        const from = stroke.points[i - 1]
        const to = stroke.points[i]

        const start = canvasToPdfPoint(from, size)
        const end = canvasToPdfPoint(to, size)

        pdfPage.drawLine({
          start,
          end,
          thickness: (stroke.width / size.canvasWidth) * size.pdfWidth,
          color: hexToRgb(stroke.color),
          opacity: segmentOpacity(stroke.tool, from.opacity ?? stroke.opacity, to.opacity ?? stroke.opacity)
        })
      }
    })
  })

  return pdfDoc.save()
}

function canvasToPdfPoint(point, size) {
  const x = (point.x / size.canvasWidth) * size.pdfWidth
  const y = size.pdfHeight - (point.y / size.canvasHeight) * size.pdfHeight

  return { x, y }
}

function errorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message
  }

  return 'Unknown error'
}
