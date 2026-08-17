import type { GenerateOptions, QRCodeData, RenderOptions } from '../generate'
import { decodePNG, generate, generateBinary, generateKanji, toCanvas, toPNG } from '../generate'
import { QrSegment } from '../generate/qrcodegen'
import type { ImageSource } from '../scan'
import { scan } from '../scan'

export interface CheckResult {
  ok: boolean
  error?: string
  mode?: 'numeric' | 'alphanumeric' | 'byte' | 'kanji'
  version?: number
  size?: number
  capacity?: number
  requiredBits?: number
}

export interface VerifyResult {
  ok: boolean
  text: string | null
  expected: string
}

function buildCheckResult(run: () => { qr: QRCodeData; segs?: QrSegment[] }): CheckResult {
  try {
    const { qr, segs } = run()
    const requiredBits = segs ? QrSegment.getTotalBits(segs, qr.version) : undefined
    return {
      ok: true,
      mode: qr.mode,
      version: qr.version,
      size: qr.size,
      capacity: qr.dataCapacity,
      ...(requiredBits !== undefined && Number.isFinite(requiredBits) ? { requiredBits } : {}),
    }
  }
  catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

export function check(text: string, options: GenerateOptions = {}): CheckResult {
  const { mode = 'auto' } = options
  if (mode === 'numeric' && !QrSegment.isNumeric(text))
    return { ok: false, error: 'Text contains non-numeric characters (numeric mode)' }
  if (mode === 'alphanumeric' && !QrSegment.isAlphanumeric(text))
    return { ok: false, error: 'Text contains unencodable characters (alphanumeric mode)' }
  return buildCheckResult(() => {
    const qr = generate(text, { ...options, boostEcc: false, mask: 0 })
    const segs = mode === 'numeric'
      ? [QrSegment.makeNumeric(text)]
      : mode === 'alphanumeric'
        ? [QrSegment.makeAlphanumeric(text)]
        : mode === 'byte'
          ? [QrSegment.makeBytes(QrSegment.toUtf8ByteArray(text))]
          : QrSegment.makeSegments(text)
    return { qr, segs }
  })
}

export function checkSegments(segments: QrSegment[], options: GenerateOptions = {}): CheckResult {
  return buildCheckResult(() => {
    const qr = generate(segments, { ...options, boostEcc: false, mask: 0 })
    return { qr, segs: segments }
  })
}

export function checkBinary(data: Uint8Array | number[], options: GenerateOptions = {}): CheckResult {
  return buildCheckResult(() => {
    const qr = generateBinary(data, { ...options, boostEcc: false, mask: 0 })
    const segs = [QrSegment.makeBytes(Array.from(data))]
    return { qr, segs }
  })
}

export function checkKanji(shiftJisBytes: Uint8Array | number[], options: GenerateOptions = {}): CheckResult {
  return buildCheckResult(() => {
    const qr = generateKanji(shiftJisBytes, { ...options, boostEcc: false, mask: 0 })
    const segs = [QrSegment.makeKanji(Array.from(shiftJisBytes))]
    return { qr, segs }
  })
}

export async function verify(text: string, image: ImageSource): Promise<VerifyResult> {
  const result = await scan(image)
  return {
    ok: result.text === text,
    text: result.text,
    expected: text,
  }
}

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
