import type { ImageDataLike } from '../scan'
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
  /**
   * Image to embed in the center of the QR Code (logo).
   * Accepts RGBA pixels (`{ data, width, height }`) or PNG bytes.
   */
  logo?: ImageDataLike | Uint8Array
  /**
   * Fraction of the QR Code width occupied by the logo. @default 0.2
   */
  logoScale?: number
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
export function generate(text: string, format: 'png', options?: RenderOptions): Uint8Array
export function generate(text: string, format: 'svg', options?: RenderOptions): string
export function generate(text: string, format: 'data-url', options?: RenderOptions): string
export function generate(text: string, options?: GenerateOptions): QRCodeData
export function generate(text: string, arg: GenerateOptions | 'png' | 'svg' | 'data-url' = {}, renderOptions: RenderOptions = {}): QRCodeData | Uint8Array | string {
  if (typeof arg === 'string') {
    const qr = generate(text)
    switch (arg) {
      case 'png':
        return toPNG(qr, renderOptions)
      case 'svg':
        return toSVG(qr, renderOptions)
      case 'data-url':
        return toDataURLSync(qr, renderOptions)
    }
  }
  const options = arg
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
  let logoTag = ''
  if (options.logo) {
    const logo = options.logo instanceof Uint8Array ? decodePNG(options.logo) : options.logo
    const logoSize = Math.max(1, Math.round(size * (options.logoScale ?? 0.2)))
    const logoOffset = (size - logoSize) / 2
    logoTag = `<image href="${encodeLogoDataURL(logo)}" x="${logoOffset}" y="${logoOffset}" width="${logoSize}" height="${logoSize}" preserveAspectRatio="xMidYMid meet"/>`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" ${dim} shape-rendering="crispEdges">`
    + `<rect width="${size}" height="${size}" fill="${fill(br, bg, bb)}"/>`
    + `<path d="${paths}" fill="${fill(cr, cg, cb)}"/>${
     logoTag
     }</svg>`
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
  if (options.logo) {
    const logo = options.logo instanceof Uint8Array ? decodePNG(options.logo) : options.logo
    const logoSize = Math.max(1, Math.round(width * (options.logoScale ?? 0.2)))
    const offset = Math.floor((width - logoSize) / 2)
    for (let y = 0; y < logoSize; y++) {
      const sy = Math.min(logo.height - 1, Math.floor(y * logo.height / logoSize))
      for (let x = 0; x < logoSize; x++) {
        const sx = Math.min(logo.width - 1, Math.floor(x * logo.width / logoSize))
        const li = (sy * logo.width + sx) * 4
        const alpha = logo.data[li + 3]
        if (alpha === 0)
          continue
        const di = ((offset + y) * width + offset + x) * 4
        const blend = alpha / 255
        data[di] = logo.data[li] * blend + data[di] * (1 - blend)
        data[di + 1] = logo.data[li + 1] * blend + data[di + 1] * (1 - blend)
        data[di + 2] = logo.data[li + 2] * blend + data[di + 2] * (1 - blend)
        data[di + 3] = 255
      }
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
  if (options.logo)
    return encodeRGBA(toImageData(qr, options))
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
  return toDataURLSync(qr, options)
}

function toDataURLSync(qr: QRCodeData, options: RenderOptions = {}): string {
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

/**
 * Maximum PNG dimension accepted by {@link decodePNG} (in pixels).
 */
export const MAX_PNG_DIM = 16384

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])

/**
 * Decode a PNG image into RGBA pixels.
 * Supports grayscale (1-bit and 8-bit), RGB and RGBA color types,
 * including filtered rows and zlib-compressed data.
 */
export function decodePNG(bytes: Uint8Array): ImageDataLike {
  if (bytes.length < PNG_SIGNATURE.length || !PNG_SIGNATURE.every((b, i) => bytes[i] === b))
    throw new Error('Not a PNG file')
  let offset = PNG_SIGNATURE.length
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat: Uint8Array[] = []
  while (offset < bytes.length) {
    const length = readUint32BE(bytes, offset)
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7])
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = readUint32BE(data, 0)
      height = readUint32BE(data, 4)
      bitDepth = data[8]
      colorType = data[9]
      if (data[10] !== 0 || data[11] !== 0 || data[12] !== 0)
        throw new Error('Unsupported PNG (compression, filter or interlace)')
      const supported = (colorType === 0 && (bitDepth === 1 || bitDepth === 8))
        || ((colorType === 2 || colorType === 6) && bitDepth === 8)
      if (!supported)
        throw new Error(`Unsupported PNG format (color type ${colorType}, bit depth ${bitDepth})`)
      if (width === 0 || height === 0 || width > MAX_PNG_DIM || height > MAX_PNG_DIM)
        throw new Error(`Invalid PNG dimensions: ${width}x${height}`)
    }
    else if (type === 'IDAT') {
      idat.push(data)
    }
    else if (type === 'IEND') {
      break
    }
    offset += length + 12
  }
  if (width === 0)
    throw new Error('PNG missing IHDR chunk')
  const raw = inflate(concatBytes(idat))
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1
  const bpp = bitDepth === 1 ? 1 : channels
  const stride = Math.ceil(width * channels * bitDepth / 8)
  const data = new Uint8ClampedArray(width * height * 4)
  const prev = new Uint8Array(stride)
  const cur = new Uint8Array(stride)
  let rawPos = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[rawPos++]
    cur.set(raw.subarray(rawPos, rawPos + stride))
    rawPos += stride
    unfilterRow(cur, prev, filter, stride, bpp)
    let outPos = y * width * 4
    for (let x = 0; x < width; x++) {
      if (bitDepth === 1) {
        const value = (cur[Math.floor(x / 8)] & (0x80 >> (x % 8))) !== 0 ? 0 : 255
        data[outPos] = value
        data[outPos + 1] = value
        data[outPos + 2] = value
        data[outPos + 3] = 255
      }
      else {
        const p = x * channels
        data[outPos] = cur[p]
        data[outPos + 1] = channels === 1 ? cur[p] : cur[p + 1]
        data[outPos + 2] = channels === 1 ? cur[p] : cur[p + 2]
        data[outPos + 3] = channels === 4 ? cur[p + 3] : 255
      }
      outPos += 4
    }
    prev.set(cur)
  }
  return { data, width, height }
}

function unfilterRow(cur: Uint8Array, prev: Uint8Array, filter: number, stride: number, bpp: number): void {
  switch (filter) {
    case 0:
      break
    case 1:
      for (let i = bpp; i < stride; i++)
        cur[i] = (cur[i] + cur[i - bpp]) & 0xFF
      break
    case 2:
      for (let i = 0; i < stride; i++)
        cur[i] = (cur[i] + prev[i]) & 0xFF
      break
    case 3:
      for (let i = 0; i < stride; i++) {
        const left = i < bpp ? 0 : cur[i - bpp]
        cur[i] = (cur[i] + ((left + prev[i]) >> 1)) & 0xFF
      }
      break
    case 4:
      for (let i = 0; i < stride; i++) {
        const a = i < bpp ? 0 : cur[i - bpp]
        const b = prev[i]
        const c = i < bpp ? 0 : prev[i - bpp]
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
        cur[i] = (cur[i] + pred) & 0xFF
      }
      break
    default:
      throw new Error(`Unsupported PNG filter: ${filter}`)
  }
}

function readUint32BE(data: Uint8Array, offset: number): number {
  return ((data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]) >>> 0
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts)
    total += part.length
  const result = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

const FIXED_LITLEN: number[] = (() => {
  const lengths = Array.from({ length: 288 }, () => 0)
  for (let i = 0; i <= 143; i++) lengths[i] = 8
  for (let i = 144; i <= 255; i++) lengths[i] = 9
  for (let i = 256; i <= 279; i++) lengths[i] = 7
  for (let i = 280; i <= 287; i++) lengths[i] = 8
  return lengths
})()

const FIXED_DIST: number[] = Array.from({ length: 30 }, () => 5)

function inflate(zlib: Uint8Array): Uint8Array {
  if (zlib.length < 2 || (zlib[0] * 256 + zlib[1]) % 31 !== 0)
    throw new Error('Invalid zlib stream')
  if ((zlib[0] & 0x0F) !== 8)
    throw new Error('Unsupported zlib compression method')
  const reader = new BitReader(zlib, (zlib[1] & 0x20) !== 0 ? 6 : 2)
  const out: number[] = []
  let final = false
  while (!final) {
    final = reader.readBit() === 1
    const type = reader.readBits(2)
    if (type === 0) {
      reader.align()
      const length = zlib[reader.pos] | (zlib[reader.pos + 1] << 8)
      reader.pos += 4
      for (let i = 0; i < length; i++)
        out.push(zlib[reader.pos + i])
      reader.pos += length
    }
    else if (type === 1 || type === 2) {
      let litLen: number[]
      let dist: number[]
      if (type === 1) {
        litLen = FIXED_LITLEN
        dist = FIXED_DIST
      }
      else {
        const tables = readDynamicTables(reader)
        litLen = tables.litLen
        dist = tables.dist
      }
      const litTable = buildHuffman(litLen)
      const distTable = buildHuffman(dist)
      let symbol = readSymbol(reader, litTable)
      while (symbol !== 256) {
        if (symbol < 256) {
          out.push(symbol)
        }
        else if (symbol < 286) {
          const index = symbol - 257
          const length = LENGTH_BASE[index] + reader.readBits(LENGTH_EXTRA[index])
          const distSymbol = readSymbol(reader, distTable)
          const distance = DIST_BASE[distSymbol] + reader.readBits(DIST_EXTRA[distSymbol])
          for (let i = 0; i < length; i++)
            out.push(out[out.length - distance])
        }
        else { throw new Error('Invalid deflate length symbol') }
        symbol = readSymbol(reader, litTable)
      }
    }
    else { throw new Error('Invalid deflate block type') }
  }
  reader.align()
  const expected = readUint32BE(zlib, reader.pos)
  const actual = adler32(Uint8Array.from(out))
  if (expected !== actual)
    throw new Error('zlib Adler-32 mismatch (corrupted data)')
  return Uint8Array.from(out)
}

function readDynamicTables(reader: BitReader): { litLen: number[]; dist: number[] } {
  const litLenCount = reader.readBits(5) + 257
  const distCount = reader.readBits(5) + 1
  const codeLengthCount = reader.readBits(4) + 4
  const codeLengths = Array.from({ length: 19 }, () => 0)
  for (let i = 0; i < codeLengthCount; i++)
    codeLengths[CODE_LENGTH_ORDER[i]] = reader.readBits(3)
  const codeTable = buildHuffman(codeLengths)
  const lengths: number[] = []
  while (lengths.length < litLenCount + distCount) {
    const symbol = readSymbol(reader, codeTable)
    if (symbol < 16) {
      lengths.push(symbol)
    }
    else if (symbol === 16) {
      const repeat = 3 + reader.readBits(2)
      const value = lengths[lengths.length - 1]
      for (let i = 0; i < repeat; i++)
        lengths.push(value)
    }
    else if (symbol === 17) {
      const repeat = 3 + reader.readBits(3)
      for (let i = 0; i < repeat; i++)
        lengths.push(0)
    }
    else {
      const repeat = 11 + reader.readBits(7)
      for (let i = 0; i < repeat; i++)
        lengths.push(0)
    }
  }
  return { litLen: lengths.slice(0, litLenCount), dist: lengths.slice(litLenCount) }
}

type HuffmanTable = Map<number, number>[]

function buildHuffman(lengths: number[]): HuffmanTable {
  const count = Array.from({ length: 16 }, () => 0)
  for (const length of lengths) {
    if (length > 0)
      count[length]++
  }
  const table: HuffmanTable = Array.from({ length: 16 }, () => new Map<number, number>())
  let code = 0
  for (let bits = 1; bits <= 15; bits++) {
    code = (code + count[bits - 1]) << 1
    const start = code
    const map = new Map<number, number>()
    for (let symbol = 0; symbol < lengths.length; symbol++) {
      if (lengths[symbol] === bits)
        map.set(code++, symbol)
    }
    table[bits] = map
    code = start
  }
  return table
}

function readSymbol(reader: BitReader, table: HuffmanTable): number {
  let code = 0
  for (let bits = 1; bits <= 15; bits++) {
    code = (code << 1) | reader.readBit()
    const map = table[bits]
    if (map) {
      const symbol = map.get(code)
      if (symbol !== undefined)
        return symbol
    }
  }
  throw new Error('Invalid Huffman code')
}

class BitReader {
  pos: number
  private bit = 0
  constructor(private data: Uint8Array, pos: number) {
    this.pos = pos
  }

  readBit(): number {
    const value = (this.data[this.pos] >> this.bit) & 1
    this.bit++
    if (this.bit === 8) {
      this.bit = 0
      this.pos++
    }
    return value
  }

  readBits(count: number): number {
    let value = 0
    for (let i = 0; i < count; i++)
      value |= this.readBit() << i
    return value
  }

  align(): void {
    if (this.bit !== 0) {
      this.pos++
      this.bit = 0
    }
  }
}

/**
 * Encode an RGBA image as a PNG (8-bit RGBA, stored-deflate, no deps).
 */
function encodeRGBA(image: ImageDataLike): Uint8Array {
  const { data, width, height } = image
  const rowBytes = width * 4
  const raw = new Uint8Array((rowBytes + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (rowBytes + 1)] = 0
    raw.set(data.subarray(y * rowBytes, (y + 1) * rowBytes), y * (rowBytes + 1) + 1)
  }
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width, false)
  view.setUint32(4, height, false)
  ihdr[8] = 8
  ihdr[9] = 6
  return encodePNG(ihdr, raw)
}

function encodeLogoDataURL(logo: ImageDataLike): string {
  const png = encodeRGBA(logo)
  let binary = ''
  for (let i = 0; i < png.length; i++)
    binary += String.fromCharCode(png[i])
  return `data:image/png;base64,${btoa(binary)}`
}

function encodePNG(ihdr: Uint8Array, raw: Uint8Array): Uint8Array {
  const parts = [
    PNG_SIGNATURE,
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

export { Ecc, Mode, QrCode, QrSegment }
