import type { GenerateOptions, QRCodeData, RenderOptions } from './generate'
import { generate, generateBinary, generateKanji, toCanvas, toPNG } from './generate'
import { QrSegment } from './qrcodegen'
import type { ImageDataLike, ImageSource } from './scan'
import { scan } from './scan'

/** Cap on PNG dimensions accepted by `decodePNG` (16k x 16k RGBA = 1 GiB). */
export const MAX_PNG_DIM = 16384

export interface CheckResult {
  /** Whether the payload can be encoded into a QR Code. */
  ok: boolean
  /** Error message when `ok` is false. */
  error?: string
  /** Mode that would be used. */
  mode?: 'numeric' | 'alphanumeric' | 'byte' | 'kanji'
  /** Smallest version that fits (without ECC boosting). */
  version?: number
  /** Matrix size in modules. */
  size?: number
  /** Data capacity in codewords for the chosen version + ECC. */
  capacity?: number
  /** Number of data bits required. */
  requiredBits?: number
}

export interface VerifyResult {
  ok: boolean
  /** Text decoded from the image. */
  text: string | null
  /** The text that was expected. */
  expected: string
}

function buildCheckResult(run: () => QRCodeData): CheckResult {
  try {
    const qr = run()
    return {
      ok: true,
      mode: qr.mode,
      version: qr.version,
      size: qr.size,
      capacity: qr.dataCapacity,
    }
  }
  catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

/**
 * Check whether the given text can be encoded into a QR Code, and report
 * the mode / version / capacity that would be used.
 *
 * Validates all format constraints: mode encodability, character count
 * field width, version 1-40 range and data capacity.
 */
export function check(text: string, options: GenerateOptions = {}): CheckResult {
  const { mode = 'auto' } = options
  if (mode === 'numeric' && !QrSegment.isNumeric(text))
    return { ok: false, error: 'Text contains non-numeric characters (numeric mode)' }
  if (mode === 'alphanumeric' && !QrSegment.isAlphanumeric(text))
    return { ok: false, error: 'Text contains unencodable characters (alphanumeric mode)' }
  return buildCheckResult(() => generate(text, { ...options, boostEcc: false, mask: 0 }))
}

export function checkBinary(data: Uint8Array | number[], options: GenerateOptions = {}): CheckResult {
  return buildCheckResult(() => generateBinary(data, { ...options, boostEcc: false, mask: 0 }))
}

export function checkKanji(shiftJisBytes: Uint8Array | number[], options: GenerateOptions = {}): CheckResult {
  return buildCheckResult(() => generateKanji(shiftJisBytes, { ...options, boostEcc: false, mask: 0 }))
}

/**
 * Scan an image and verify it decodes to the expected text.
 */
export async function verify(text: string, image: ImageSource): Promise<VerifyResult> {
  const result = await scan(image)
  return {
    ok: result.text === text,
    text: result.text,
    expected: text,
  }
}

/**
 * Round-trip check: render a generated QR Code to pixels and scan it back,
 * confirming it decodes to exactly the payload it was generated from.
 *
 * Works in browsers (canvas) and Node.js (built-in PNG encoder/decoder).
 */
export async function verifyGenerated(qr: QRCodeData, options: RenderOptions = {}): Promise<VerifyResult> {
  const source = await qrToImageSource(qr, options)
  const result = await scan(source)
  return {
    ok: result.text === qr.text,
    text: result.text,
    expected: qr.text,
  }
}

async function qrToImageSource(qr: QRCodeData, options: RenderOptions): Promise<ImageSource> {
  if (typeof document !== 'undefined' && typeof HTMLCanvasElement !== 'undefined')
    return toCanvas(qr, options)
  return decodePNG(toPNG(qr, options))
}

/**
 * Decode a PNG produced by `toPNG` (1-bit grayscale, stored-deflate) into
 * an ImageData-compatible format. Dependency-free, works in Node.js.
 */
export function decodePNG(bytes: Uint8Array): ImageDataLike {
  if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4E || bytes[3] !== 0x47)
    throw new Error('Not a PNG file')

  let offset = 8
  let width = 0
  let height = 0
  const idat: Uint8Array[] = []

  while (offset < bytes.length) {
    const len = readUint32BE(bytes, offset)
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7])
    const data = bytes.subarray(offset + 8, offset + 8 + len)
    switch (type) {
      case 'IHDR': {
        width = readUint32BE(data, 0)
        height = readUint32BE(data, 4)
        if (data[8] !== 1 || data[9] !== 0)
          throw new Error('Unsupported PNG format (only 1-bit grayscale)')
        if (width === 0 || height === 0 || width > MAX_PNG_DIM || height > MAX_PNG_DIM)
          throw new Error(`Unsupported PNG dimensions (${width}x${height})`)
        break
      }
      case 'IDAT':
        idat.push(data)
        break
      case 'IEND':
        offset = bytes.length
        break
    }
    offset += 12 + len
  }

  const raw = inflateStored(concatBytes(idat))
  const rowBytes = Math.ceil(width / 8)
  const output = new Uint8ClampedArray(width * height * 4)

  for (let y = 0; y < height; y++) {
    const rowOffset = y * (rowBytes + 1)
    if (raw[rowOffset] !== 0)
      throw new Error('Unsupported PNG filter')
    for (let x = 0; x < width; x++) {
      const dark = (raw[rowOffset + 1 + Math.floor(x / 8)] & (0x80 >> (x % 8))) !== 0
      const i = (y * width + x) * 4
      output[i] = dark ? 0 : 255
      output[i + 1] = dark ? 0 : 255
      output[i + 2] = dark ? 0 : 255
      output[i + 3] = 255
    }
  }

  return { data: output, width, height }
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function inflateStored(zlib: Uint8Array): Uint8Array {
  const out: number[] = []
  let offset = 2
  let end = -1
  while (offset < zlib.length) {
    const block = zlib[offset]
    offset += 1
    const bfinal = block & 1
    const btype = (block >> 1) & 3
    if (btype !== 0)
      throw new Error('Unsupported deflate block type')
    const len = zlib[offset] | (zlib[offset + 1] << 8)
    offset += 4
    for (let i = 0; i < len; i++)
      out.push(zlib[offset + i])
    offset += len
    if (bfinal === 1) {
      end = offset
      break
    }
  }
  if (end === -1 || zlib.length - end < 4)
    throw new Error('Truncated zlib stream (missing Adler-32)')
  const expected = readUint32BE(zlib, end)
  const actual = adler32(out)
  if (expected !== actual)
    throw new Error('zlib Adler-32 mismatch (corrupted data)')
  return Uint8Array.from(out)
}

function adler32(data: number[]): number {
  let a = 1
  let b = 0
  for (const byte of data) {
    a = (a + byte) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}
