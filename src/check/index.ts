import type { GenerateOptions, QRCodeData, RenderOptions } from '../generate'
import { decodePNG, generate, generateBinary, generateKanji, toCanvas, toPNG } from '../generate'
import { QrSegment } from '../generate/qrcodegen'
import type { ImageSource } from '../scan'
import { scan } from '../scan'

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
