import { Ecc, Mode, QrCode, QrSegment } from './qrcodegen'

export type EccLevel = 'L' | 'M' | 'Q' | 'H'
export type DataMode = 'auto' | 'numeric' | 'alphanumeric' | 'byte'

export interface GenerateOptions {
  /**
   * Error correction level. @default 'M'
   */
  ecc?: EccLevel
  /**
   * Data mode. When 'auto', the most compact mode is chosen automatically
   * (numeric > alphanumeric > byte). @default 'auto'
   */
  mode?: DataMode
  /**
   * Force a specific version (1-40). Defaults to the smallest version that fits.
   */
  version?: number
  /**
   * Smallest version to consider. @default 1
   */
  minVersion?: number
  /**
   * Largest version to consider. @default 40
   */
  maxVersion?: number
  /**
   * Force a mask pattern (0-7), or -1 for automatic selection. @default -1
   */
  mask?: number
  /**
   * Boost the ECC level if it fits without growing the version. @default true
   */
  boostEcc?: boolean
  /**
   * Extended Channel Interpretation assignment value (e.g. 26 for UTF-8).
   */
  eci?: number
}

export interface QRCodeData {
  /** The encoded payload. */
  text: string
  /** QR version (1-40). */
  version: number
  /** Matrix width/height in modules (17 + version * 4). */
  size: number
  /** Error correction level used. */
  ecc: EccLevel
  /** Mask pattern used (0-7). */
  mask: number
  /** Segment mode actually used. */
  mode: 'numeric' | 'alphanumeric' | 'byte' | 'kanji'
  /** Raw module matrix, `1` = dark, row-major. */
  matrix: Uint8Array
  /** Data capacity in codewords for this version + ECC. */
  dataCapacity: number
}

export interface RenderOptions {
  /**
   * Number of modules per pixel. @default 4
   */
  scale?: number
  /**
   * Quiet zone size in modules. @default 4
   */
  border?: number
  /**
   * Color of dark modules. @default '#000000'
   */
  color?: string
  /**
   * Color of light modules. @default '#ffffff'
   */
  background?: string
}

const ECC_MAP = { L: Ecc.LOW, M: Ecc.MEDIUM, Q: Ecc.QUARTILE, H: Ecc.HIGH } as const
const ECC_NAMES: Record<number, EccLevel> = { 0: 'L', 1: 'M', 2: 'Q', 3: 'H' }

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex)
  if (!m)
    throw new RangeError(`Invalid color: ${hex}`)
  const value = m[1].length === 3
    ? m[1].split('').map(c => c + c).join('')
    : m[1]
  const n = Number.parseInt(value, 16)
  return [(n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF]
}

/** Cap on the rendered width/height of `toImageData` (8192^2 x 4 bytes = 256 MB RGBA). */
const MAX_RENDER_DIM = 8192

function toMatrix(qr: QrCode): Uint8Array {
  const matrix = new Uint8Array(qr.size * qr.size)
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++)
      matrix[y * qr.size + x] = qr.getModule(x, y) ? 1 : 0
  }
  return matrix
}

function detectMode(text: string): 'numeric' | 'alphanumeric' | 'byte' {
  if (QrSegment.isNumeric(text))
    return 'numeric'
  if (QrSegment.isAlphanumeric(text))
    return 'alphanumeric'
  return 'byte'
}

function toUtf8Bytes(text: string): number[] {
  return QrSegment.toUtf8ByteArray(text)
}

function encodeSegments(segs: QrSegment[], options: GenerateOptions): QrCode {
  const {
    ecc = 'M',
    version,
    minVersion = 1,
    maxVersion = 40,
    mask = -1,
    boostEcc = true,
  } = options

  if (version !== undefined && (version < 1 || version > 40))
    throw new RangeError('Version must be between 1 and 40')
  if (minVersion < 1 || minVersion > maxVersion || maxVersion > 40)
    throw new RangeError('Invalid version range')

  const min = version ?? minVersion
  const max = version ?? maxVersion
  return QrCode.encodeSegments(segs, ECC_MAP[ecc], min, max, mask, boostEcc)
}

function buildResult(qr: QrCode, text: string, mode: QRCodeData['mode']): QRCodeData {
  return {
    text,
    version: qr.version,
    size: qr.size,
    ecc: ECC_NAMES[qr.errorCorrectionLevel.ordinal],
    mask: qr.mask,
    mode,
    matrix: toMatrix(qr),
    dataCapacity: QrCode.getNumDataCodewords(qr.version, qr.errorCorrectionLevel),
  }
}

/**
 * Generate a QR Code from a text string.
 *
 * Supports all versions (1-40), all error correction levels, and automatic
 * mode selection (numeric / alphanumeric / byte, UTF-8 encoded).
 */
export function generate(text: string, options: GenerateOptions = {}): QRCodeData {
  const { mode = 'auto', eci } = options

  let segs: QrSegment[]
  let usedMode: QRCodeData['mode']
  switch (mode) {
    case 'numeric': {
      if (!QrSegment.isNumeric(text))
        throw new RangeError('Text contains non-numeric characters (numeric mode)')
      segs = [QrSegment.makeNumeric(text)]
      usedMode = 'numeric'
      break
    }
    case 'alphanumeric': {
      if (!QrSegment.isAlphanumeric(text))
        throw new RangeError('Text contains unencodable characters (alphanumeric mode)')
      segs = [QrSegment.makeAlphanumeric(text)]
      usedMode = 'alphanumeric'
      break
    }
    case 'byte': {
      segs = [QrSegment.makeBytes(toUtf8Bytes(text))]
      usedMode = 'byte'
      break
    }
    case 'auto': {
      const autoMode = detectMode(text)
      segs = autoMode === 'byte'
        ? [QrSegment.makeBytes(toUtf8Bytes(text))]
        : autoMode === 'numeric'
          ? [QrSegment.makeNumeric(text)]
          : [QrSegment.makeAlphanumeric(text)]
      usedMode = autoMode
      break
    }
    default:
      throw new RangeError(`Invalid mode: ${mode}`)
  }

  if (eci !== undefined) {
    if (eci < 0)
      throw new RangeError('ECI assignment value out of range')
    segs = [QrSegment.makeEci(eci), ...segs]
  }

  return buildResult(encodeSegments(segs, options), text, usedMode)
}

/**
 * Generate a QR Code from raw binary data (byte mode).
 * Max 2953 bytes.
 */
export function generateBinary(data: Uint8Array | number[], options: GenerateOptions = {}): QRCodeData {
  const { eci } = options
  const segs = eci !== undefined
    ? [QrSegment.makeEci(eci), QrSegment.makeBytes(Array.from(data))]
    : [QrSegment.makeBytes(Array.from(data))]
  return buildResult(encodeSegments(segs, options), '', 'byte')
}

/**
 * Generate a QR Code in kanji mode from Shift_JIS-encoded bytes
 * (JIS X 0208 double-byte characters).
 */
export function generateKanji(shiftJisBytes: Uint8Array | number[], options: GenerateOptions = {}): QRCodeData {
  const segs = [QrSegment.makeKanji(Array.from(shiftJisBytes))]
  return buildResult(encodeSegments(segs, options), '', 'kanji')
}

/**
 * Render the QR Code to an SVG string.
 */
export function toSVG(qr: QRCodeData, options: RenderOptions = {}): string {
  const {
    scale = 4,
    border = 4,
    color = '#000000',
    background = '#ffffff',
  } = options
  const size = qr.size + border * 2
  const width = size * scale
  const dim = `width="${width}" height="${width}" viewBox="0 0 ${size} ${size}"`
  const [cr, cg, cb] = hexToRgb(color)
  const [br, bg, bb] = hexToRgb(background)
  const fill = (r: number, g: number, b: number) => `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
  let paths = ''
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.matrix[y * qr.size + x]) {
        const px = x + border
        const py = y + border
        paths += `M${px} ${py}h1v1h-1z`
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" ${dim} shape-rendering="crispEdges">`
    + `<rect width="${size}" height="${size}" fill="${fill(br, bg, bb)}"/>`
    + `<path d="${paths}" fill="${fill(cr, cg, cb)}"/>`
    + '</svg>'
}

/**
 * Render the QR Code to RGBA pixels.
 */
export function toImageData(qr: QRCodeData, options: RenderOptions = {}): { data: Uint8ClampedArray; width: number; height: number } {
  const {
    scale = 4,
    border = 4,
    color = '#000000',
    background = '#ffffff',
  } = options
  const [cr, cg, cb] = hexToRgb(color)
  const [br, bg, bb] = hexToRgb(background)
  const size = qr.size + border * 2
  const width = size * scale
  if (width > MAX_RENDER_DIM)
    throw new RangeError(`Rendered size ${width} exceeds the ${MAX_RENDER_DIM}px limit`)
  const data = new Uint8ClampedArray(width * width * 4)
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      const mx = Math.floor(x / scale) - border
      const my = Math.floor(y / scale) - border
      const dark = mx >= 0 && my >= 0 && mx < qr.size && my < qr.size && qr.matrix[my * qr.size + mx] === 1
      const i = (y * width + x) * 4
      data[i] = dark ? cr : br
      data[i + 1] = dark ? cg : bg
      data[i + 2] = dark ? cb : bb
      data[i + 3] = 255
    }
  }
  return { data, width, height: width }
}

export function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]
    for (let j = 0; j < 8; j++)
      crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1))
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

function adler32(data: Uint8Array): number {
  let a = 1
  let b = 0
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}

function deflateStored(data: Uint8Array): Uint8Array {
  const out: number[] = []
  let offset = 0
  const totalBlocks = Math.ceil(data.length / 65535)
  let index = 0
  while (offset < data.length) {
    const len = Math.min(65535, data.length - offset)
    out.push(index === totalBlocks - 1 ? 0x01 : 0x00)
    out.push(len & 0xFF, (len >> 8) & 0xFF, (~len) & 0xFF, (~len >> 8) & 0xFF)
    for (let i = 0; i < len; i++)
      out.push(data[offset + i])
    offset += len
    index++
  }
  const adler = adler32(data)
  return Uint8Array.from([0x78, 0x01, ...out, (adler >>> 24) & 0xFF, (adler >>> 16) & 0xFF, (adler >>> 8) & 0xFF, adler & 0xFF])
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type)
  const lenBytes = new Uint8Array(4)
  new DataView(lenBytes.buffer).setUint32(0, data.length, false)
  const crcData = new Uint8Array(typeBytes.length + data.length)
  crcData.set(typeBytes)
  crcData.set(data, typeBytes.length)
  const crcBytes = new Uint8Array(4)
  new DataView(crcBytes.buffer).setUint32(0, crc32(crcData), false)
  const out = new Uint8Array(lenBytes.length + crcData.length + crcBytes.length)
  out.set(lenBytes)
  out.set(crcData, lenBytes.length)
  out.set(crcBytes, lenBytes.length + crcData.length)
  return out
}

/**
 * Encode the QR Code as a PNG (1-bit grayscale, stored-deflate, no deps).
 */
export function toPNG(qr: QRCodeData, options: RenderOptions = {}): Uint8Array {
  const {
    scale = 4,
    border = 4,
  } = options
  const size = qr.size + border * 2
  const width = size * scale
  const rowBytes = Math.ceil(width / 8)
  const raw = new Uint8Array((rowBytes + 1) * width)

  for (let y = 0; y < width; y++) {
    const rowOffset = y * (rowBytes + 1)
    raw[rowOffset] = 0
    for (let x = 0; x < width; x++) {
      const mx = Math.floor(x / scale) - border
      const my = Math.floor(y / scale) - border
      const dark = mx >= 0 && my >= 0 && mx < qr.size && my < qr.size && qr.matrix[my * qr.size + mx] === 1
      if (dark)
        raw[rowOffset + 1 + Math.floor(x / 8)] |= 0x80 >> (x % 8)
    }
  }

  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width, false)
  view.setUint32(4, width, false)
  ihdr[8] = 1
  ihdr[9] = 0
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateStored(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]
  const total = parts.reduce((sum, p) => sum + p.length, 0)
  const png = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    png.set(part, offset)
    offset += part.length
  }
  return png
}

/**
 * Render the QR Code to a data URL (`data:image/png;base64,...`).
 * Uses canvas in browsers and a dependency-free PNG encoder in Node.js.
 */
export async function toDataURL(qr: QRCodeData, options: RenderOptions = {}): Promise<string> {
  if (typeof document !== 'undefined' && typeof HTMLCanvasElement !== 'undefined') {
    const canvas = toCanvas(qr, options)
    return canvas.toDataURL('image/png')
  }
  const png = toPNG(qr, options)
  let binary = ''
  for (let i = 0; i < png.length; i++)
    binary += String.fromCharCode(png[i])
  return `data:image/png;base64,${btoa(binary)}`
}

/**
 * Render the QR Code onto a canvas element (browser only).
 */
export function toCanvas(qr: QRCodeData, options: RenderOptions = {}): HTMLCanvasElement {
  if (typeof document === 'undefined' || typeof HTMLCanvasElement === 'undefined')
    throw new Error('toCanvas is only available in browsers')
  const { data, width } = toImageData(qr, options)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = width
  const ctx = canvas.getContext('2d')!
  const imageData = ctx.createImageData(width, width)
  imageData.data.set(data)
  ctx.putImageData(imageData, 0, 0)
  return canvas
}

export { Ecc, Mode, QrCode, QrSegment }
