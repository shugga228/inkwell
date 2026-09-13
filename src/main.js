import { PDFDocument, rgb } from 'pdf-lib'
import * as pdfjsLib from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc

const ui = {
  pdfInput: document.querySelector('#pdfInput'),
  toolSelect: document.querySelector('#toolSelect'),
  penColor: document.querySelector('#penColor'),
  highlighterColor: document.querySelector('#highlighterColor'),
  smoothingEnabled: document.querySelector('#smoothingEnabled'),
  smoothingWeight: document.querySelector('#smoothingWeight'),
  weightValue: document.querySelector('#weightValue'),
  exportButton: document.querySelector('#exportButton'),
  status: document.querySelector('#status'),
  pages: document.querySelector('#pages')
}

const state = {
  pdfBytes: null,
  pdfDoc: null,
  pageSizes: [],
  annotations: [],
  activeStroke: null,
  currentPointerId: null,
  scale: 1.4,
  defaultPenOpacity: 0.65,
  highlighterOpacity: 0.23,
  penWidth: 2.4,
  highlighterWidth: 14
}

ui.smoothingWeight.addEventListener('input', () => {
  ui.weightValue.value = ui.smoothingWeight.value
})

ui.pdfInput.addEventListener('change', async (event) => {
  const [file] = event.target.files ?? []
  if (!file) {
    return
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  state.pdfBytes = bytes
  state.annotations = []
  ui.exportButton.disabled = true

  await loadAndRenderPdf(bytes)
  ui.status.textContent = `Loaded: ${file.name}`
  ui.exportButton.disabled = false
})

ui.exportButton.addEventListener('click', async () => {
  if (!state.pdfBytes) {
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
  } catch {
    ui.status.textContent = 'Export failed. Please try again.'
  } finally {
    ui.exportButton.disabled = false
  }
})

async function loadAndRenderPdf(bytes) {
  ui.pages.replaceChildren()

  const loadingTask = pdfjsLib.getDocument({ data: bytes })
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
}

function setupDrawing(canvas, pageIndex) {
  const ctx = canvas.getContext('2d')

  canvas.onpointerdown = (event) => {
    if (event.button !== 0) {
      return
    }

    canvas.setPointerCapture(event.pointerId)
    state.currentPointerId = event.pointerId

    const point = pointFromEvent(event, canvas)
    const opacity = resolveOpacity(event)

    state.activeStroke = {
      pageIndex,
      tool: ui.toolSelect.value,
      color: ui.toolSelect.value === 'pen' ? ui.penColor.value : ui.highlighterColor.value,
      width: ui.toolSelect.value === 'pen' ? state.penWidth : state.highlighterWidth,
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
    const opacity = resolveOpacity(event)

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
    state.annotations[stroke.pageIndex].push({
      tool: stroke.tool,
      color: stroke.color,
      width: stroke.width,
      points: stroke.points
    })

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

function resolveOpacity(event) {
  if (event.pressure && event.pressure > 0) {
    return clamp(event.pressure, 0.05, 1)
  }

  return state.defaultPenOpacity
}

function segmentOpacity(tool, fromOpacity, toOpacity) {
  if (tool === 'highlighter') {
    return state.highlighterOpacity
  }

  return clamp((fromOpacity + toOpacity) / 2, 0.05, 1)
}

function pointFromEvent(event, canvas) {
  const rect = canvas.getBoundingClientRect()
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
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
          opacity: segmentOpacity(stroke.tool, from.opacity, to.opacity)
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
