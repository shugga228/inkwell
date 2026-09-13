import { PDFDocument, rgb } from 'pdf-lib'
import * as pdfjsLib from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc

const ui = {
  pdfInput: document.querySelector('#pdfInput'),
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
  activeStroke: null,
  currentPointerId: null,
  scale: 2,
  zoom: 1,
  isPanning: false,
  panStart: null,
  defaultPenOpacity: 0.65,
  highlighterOpacity: 0.23,
  penWidth: 2.4,
  highlighterWidth: 14,
  history: [],
  historyIndex: -1
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
ui.zoomOutButton.addEventListener('click', () => setZoom(state.zoom - 0.25))
ui.zoomInButton.addEventListener('click', () => setZoom(state.zoom + 0.25))
ui.toolButtons.forEach((button) => {
  button.addEventListener('click', () => {
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
  setZoom(state.zoom + (event.deltaY < 0 ? 0.25 : -0.25))
}, { passive: false })

document.addEventListener('keydown', (event) => {
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

  const bytes = new Uint8Array(await file.arrayBuffer())
  state.pdfBytes = bytes
  state.exportSupported = false
  state.annotations = []
  state.history = []
  state.historyIndex = -1
  ui.exportButton.disabled = true

  try {
    await loadAndRenderPdf(bytes)

    const compatibility = await checkExportCompatibility(bytes)
    state.exportSupported = compatibility.ok

    if (compatibility.ok) {
      ui.status.textContent = `Loaded: ${file.name}`
      ui.exportButton.disabled = false
      return
    }

    ui.status.textContent = `Loaded: ${file.name}. Export unavailable: ${compatibility.message}`
  } catch (error) {
    ui.status.textContent = `Failed to load PDF: ${errorMessage(error)}`
  }
})

ui.exportButton.addEventListener('click', async () => {
  if (!state.pdfBytes || !state.exportSupported) {
    ui.status.textContent = 'This PDF cannot be exported by the current export engine.'
    return
  }

  ui.exportButton.disabled = true
  ui.status.textContent = 'Exporting…'

  try {
    const output = await exportPdfWithAnnotations()
    const blob = new Blob([output], { type: 'application/pdf' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'annotated.pdf'
    link.click()
    URL.revokeObjectURL(url)
    ui.status.textContent = 'Export complete.'
  } catch (error) {
    ui.status.textContent = `Export failed: ${errorMessage(error)}`
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

async function loadAndRenderPdf(bytes) {
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
    wrapper.append(baseCanvas, annotationCanvas)

    ui.pages.append(wrapper)

    const context = baseCanvas.getContext('2d')
    await page.render({ canvasContext: context, viewport }).promise

    setupDrawing(annotationCanvas, pageNumber - 1)
    state.annotations[pageNumber - 1] = []
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
  updateHistoryButtons()
}

function restoreHistory(index) {
  if (index < 0 || index >= state.history.length) return

  state.historyIndex = index
  state.annotations = structuredClone(state.history[index])
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

function setZoom(value) {
  state.zoom = clamp(Number(value), 0.5, 3)
  ui.pages.style.setProperty('--zoom', state.zoom)
  ui.zoomValue.value = `${Math.round(state.zoom * 100)}%`
  ui.zoomOutButton.disabled = state.zoom <= 0.5
  ui.zoomInButton.disabled = state.zoom >= 3
  updateCanvasCursors()
}

function updateCanvasCursors() {
  updateCursorRingSize()
}

function updateCursorRingSize() {
  if (!state.cursorCanvas) return

  const tool = ui.toolSelect.value
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
