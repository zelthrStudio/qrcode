export interface ScanResult {
  text: string | null
  rect?: {
    x: number
    y: number
    width: number
    height: number
  }
  rectCanvas?: HTMLCanvasElement
}

export interface ScanOptions {
  includeRectCanvas?: boolean
}

async function importOpenCV(): Promise<InternalObject> {
  const cv = await import('./wasm').then(r => r.cv)
  await cv.ready
  const qrcode_detector = await loadModels(cv)
  return {
    cv,
    qrcode_detector,
  }
}

interface InternalObject {
  cv: any
  qrcode_detector: any
}

export interface ImageDataLike {
  data: Uint8ClampedArray | Uint8Array
  width: number
  height: number
}

export type ImageSource =
  | ImageDataLike
  | ImageData
  | HTMLCanvasElement
  | HTMLImageElement
  | HTMLVideoElement
  | OffscreenCanvas
  | ImageBitmap

export const MAX_IMAGE_DIM = 16384
export const MAX_IMAGE_PIXELS = 40_000_000

let _promise: Promise<InternalObject> | undefined

async function getOpenCV() {
  if (!_promise) {
    _promise = importOpenCV().catch((err) => {
      _promise = undefined
      throw err
    })
  }
  return _promise
}

function getImageDimensions(input: any): { width: number; height: number } {
  if (!input || typeof input !== 'object')
    throw new TypeError('Invalid image input')
  const width = input.videoWidth ?? input.naturalWidth ?? input.width
  const height = input.videoHeight ?? input.naturalHeight ?? input.height
  return { width, height }
}

function validateImage(input: ImageSource): { width: number; height: number } {
  const { width, height } = getImageDimensions(input)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
    throw new RangeError(`Invalid image dimensions: ${width}x${height}`)
  if (width > MAX_IMAGE_DIM || height > MAX_IMAGE_DIM)
    throw new RangeError(`Image dimensions ${width}x${height} exceed the ${MAX_IMAGE_DIM}px limit`)
  if (width * height > MAX_IMAGE_PIXELS)
    throw new RangeError(`Image pixel count ${width * height} exceeds the ${MAX_IMAGE_PIXELS}px limit`)
  return { width, height }
}

export async function ready() {
  await getOpenCV()
}

export async function scan(input: ImageSource, options: ScanOptions = {}): Promise<ScanResult> {
  validateImage(input)
  const { cv, qrcode_detector } = await getOpenCV()
  const inputImage = cv.imread(input, cv.IMREAD_GRAYSCALE)
  const points_vec = new cv.MatVector()
  let res: any
  let points: any
  try {
    res = qrcode_detector.detectAndDecode(inputImage, points_vec)
    points = points_vec.get(0)
    const rect = points
      ? {
          x: Math.min(points.floatAt(0), points.floatAt(2), points.floatAt(4), points.floatAt(6)),
          y: Math.min(points.floatAt(1), points.floatAt(3), points.floatAt(5), points.floatAt(7)),
          width: Math.max(points.floatAt(0), points.floatAt(2), points.floatAt(4), points.floatAt(6))
            - Math.min(points.floatAt(0), points.floatAt(2), points.floatAt(4), points.floatAt(6)),
          height: Math.max(points.floatAt(1), points.floatAt(3), points.floatAt(5), points.floatAt(7))
            - Math.min(points.floatAt(1), points.floatAt(3), points.floatAt(5), points.floatAt(7)),
        }
      : undefined

    let rectCanvas: HTMLCanvasElement | undefined
    if (rect && options.includeRectCanvas && rect.width > 0 && rect.height > 0) {
      if (typeof document === 'undefined')
        throw new Error('includeRectCanvas is only available in browsers')
      rectCanvas = document.createElement('canvas')
      const dst = inputImage.roi(new cv.Rect(rect.x, rect.y, rect.width, rect.height))
      cv.imshow(rectCanvas, dst)
      dst.delete()
    }

    return {
      text: res.size() > 0 ? res.get(0) : null,
      rect,
      rectCanvas,
    }
  }
  finally {
    if (points)
      points.delete()
    if (res)
      res.delete()
    points_vec.delete()
    inputImage.delete()
  }
}

export async function scanAll(input: ImageSource, options: ScanOptions = {}): Promise<ScanResult[]> {
  validateImage(input)
  const { cv, qrcode_detector } = await getOpenCV()
  const inputImage = cv.imread(input, cv.IMREAD_GRAYSCALE)
  const points_vec = new cv.MatVector()
  let res: any
  const results: ScanResult[] = []
  const pointMats: any[] = []

  try {
    res = qrcode_detector.detectAndDecode(inputImage, points_vec)
    const count = res.size()
    for (let i = 0; i < count; i++) {
      const text = res.get(i)
      let rect: ScanResult['rect']
      let rectCanvas: HTMLCanvasElement | undefined
      if (i < points_vec.size()) {
        const pts = points_vec.get(i)
        pointMats.push(pts)
        if (pts) {
          rect = {
            x: Math.min(pts.floatAt(0), pts.floatAt(2), pts.floatAt(4), pts.floatAt(6)),
            y: Math.min(pts.floatAt(1), pts.floatAt(3), pts.floatAt(5), pts.floatAt(7)),
            width: Math.max(pts.floatAt(0), pts.floatAt(2), pts.floatAt(4), pts.floatAt(6))
              - Math.min(pts.floatAt(0), pts.floatAt(2), pts.floatAt(4), pts.floatAt(6)),
            height: Math.max(pts.floatAt(1), pts.floatAt(3), pts.floatAt(5), pts.floatAt(7))
              - Math.min(pts.floatAt(1), pts.floatAt(3), pts.floatAt(5), pts.floatAt(7)),
          }
          if (options.includeRectCanvas && rect.width > 0 && rect.height > 0) {
            if (typeof document === 'undefined')
              throw new Error('includeRectCanvas is only available in browsers')
            rectCanvas = document.createElement('canvas')
            const dst = inputImage.roi(new cv.Rect(rect.x, rect.y, rect.width, rect.height))
            cv.imshow(rectCanvas, dst)
            dst.delete()
          }
        }
      }
      results.push({ text, rect, rectCanvas })
    }
    return results
  }
  finally {
    for (const p of pointMats) {
      if (p)
        p.delete()
    }
    if (res)
      res.delete()
    points_vec.delete()
    inputImage.delete()
  }
}

async function loadModels(cv: any) {
  const models = await import('./wasm')

  cv.FS_createDataFile('/', 'detect.prototxt', models.detect_prototxt, true, false, false)
  cv.FS_createDataFile('/', 'detect.caffemodel', models.detect_caffemodel, true, false, false)
  cv.FS_createDataFile('/', 'sr.prototxt', models.sr_prototxt, true, false, false)
  cv.FS_createDataFile('/', 'sr.caffemodel', models.sr_caffemodel, true, false, false)

  const Detector = cv.wechat_qrcode_WeChatQRCode
  const qrcode_detector = new Detector(
    'detect.prototxt',
    'detect.caffemodel',
    'sr.prototxt',
    'sr.caffemodel',
  )

  return qrcode_detector
}
