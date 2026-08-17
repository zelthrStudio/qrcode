import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import {
  billPayment,
  check,
  checkBinary,
  checkPromptPay,
  checkSegments,
  crc32,
  decodePNG,
  decodePromptPay,
  generate,
  generateBillPayment,
  generateBinary,
  generatePromptPay,
  parseColor,
  parsePromptPay,
  promptPay,
  scan,
  scanAll,
  toANSI,
  toDataURL,
  toImageData,
  toPNG,
  toSVG,
  toTerminal,
  toUTF8,
  verify,
  verifyGenerated,
} from '../src'
import { Ecc, Mode, QrCode, QrSegment } from '../src/generate/qrcodegen'

const __filename = fileURLToPath(import.meta.url)
const ECC_BY_LETTER = { L: Ecc.LOW, M: Ecc.MEDIUM, Q: Ecc.QUARTILE, H: Ecc.HIGH } as const

async function scanQRData(data: Uint8ClampedArray | Uint8Array, width: number, height: number) {
  return scan({ data, width, height })
}

async function renderAndScan(text: string, options?: Parameters<typeof generate>[1], renderOptions?: Parameters<typeof toPNG>[1]) {
  const qr = generate(text, options)
  const png = toPNG(qr, { scale: 4, border: 4, ...renderOptions })
  const image = decodePNG(png)
  const result = await scanQRData(image.data, image.width, image.height)
  return { qr, result }
}

describe('encoder: all modes', () => {
  it('auto-detects numeric mode', () => {
    const qr = generate('1234567890')
    expect(qr.mode).toBe('numeric')
    expect(qr.version).toBe(1)
  })

  it('auto-detects alphanumeric mode', () => {
    const qr = generate('HELLO WORLD 123')
    expect(qr.mode).toBe('alphanumeric')
  })

  it('falls back to byte mode for lowercase and unicode', () => {
    const qr = generate('hello world สวัสดี 你好')
    expect(qr.mode).toBe('byte')
    expect(qr.matrix.length).toBe(qr.size * qr.size)
  })

  it('forces numeric mode', () => {
    const qr = generate('0123456789', { mode: 'numeric' })
    expect(qr.mode).toBe('numeric')
    expect(() => generate('abc', { mode: 'numeric' })).toThrow()
  })

  it('forces alphanumeric mode', () => {
    const qr = generate('ABC $%*+-./:', { mode: 'alphanumeric' })
    expect(qr.mode).toBe('alphanumeric')
    expect(() => generate('abc', { mode: 'alphanumeric' })).toThrow()
  })

  it('forces byte mode', () => {
    const qr = generate('123', { mode: 'byte' })
    expect(qr.mode).toBe('byte')
  })

  it('encodes kanji mode segments (JIS X 0208)', () => {
    const seg = QrSegment.makeKanji([0x82, 0xA0, 0x82, 0xA2])
    expect(seg.mode).toBe(Mode.KANJI)
    expect(seg.numChars).toBe(2)
    expect(seg.getData().join('')).toBe('00001001000000000100100010')
  })

  it('rejects invalid kanji bytes', () => {
    expect(() => QrSegment.makeKanji([0x00, 0x00])).toThrow()
    expect(() => QrSegment.makeKanji([0x82])).toThrow()
  })

  it('encodes binary data', () => {
    const bytes = Uint8Array.from([0, 1, 2, 255, 128, 65])
    const qr = generateBinary(bytes)
    expect(qr.mode).toBe('byte')
    expect(qr.version).toBe(1)
  })

  it('supports passing QrSegment array directly to generate', () => {
    const segs = [
      QrSegment.makeNumeric('12345'),
      QrSegment.makeAlphanumeric('HELLO'),
    ]
    const qr = generate(segs)
    expect(qr.version).toBeGreaterThanOrEqual(1)
    expect(qr.matrix.length).toBe(qr.size * qr.size)
  })
})

describe('encoder: all error correction levels', () => {
  it.each(['L', 'M', 'Q', 'H'] as const)('encodes with ECC %s', (ecc) => {
    const qr = generate('qrcode test payload 123', { ecc, boostEcc: false })
    expect(qr.ecc).toBe(ecc)
    expect(() => generate('x'.repeat(100), { ecc, maxVersion: 40 })).not.toThrow()
  })

  it('boosts ECC when possible', () => {
    const boosted = generate('HELLO WORLD', { ecc: 'L' })
    expect(boosted.ecc).toBe('Q')
    const fixed = generate('HELLO WORLD', { ecc: 'L', boostEcc: false })
    expect(fixed.ecc).toBe('L')
  })
})

describe('encoder: versions and masks', () => {
  it('selects the smallest fitting version', () => {
    const small = generate('x'.repeat(10))
    const large = generate('x'.repeat(500))
    expect(small.version).toBeLessThan(large.version)
  })

  it('respects forced version', () => {
    const qr = generate('hi', { version: 5, boostEcc: false })
    expect(qr.version).toBe(5)
    expect(qr.size).toBe(17 + 5 * 4)
  })

  it('throws when data does not fit', () => {
    expect(() => generate('x'.repeat(3000), { version: 5 })).toThrow()
    expect(() => generateBinary(new Uint8Array(3000))).toThrow()
  })

  it('encodes max capacity binary at v40', () => {
    const qr = generateBinary(new Uint8Array(2953), { ecc: 'L', boostEcc: false })
    expect(qr.version).toBe(40)
  })

  it.each([0, 1, 2, 3, 4, 5, 6, 7])('supports mask %i', async (mask) => {
    const { qr, result } = await renderAndScan(`mask test ${mask}`, { mask }, { scale: 4 })
    expect(qr.mask).toBe(mask)
    expect(result.text).toBe(`mask test ${mask}`)
  })
})

describe('encoder: version coverage 1-40', () => {
  const targets = [1, 2, 3, 5, 7, 10, 14, 20, 27, 32, 40]

  function payloadForVersion(version: number, ecc: Ecc) {
    const bits = QrCode.getNumDataCodewords(version, ecc) * 8
    const ccbits = version <= 9 ? 8 : 16
    const n = Math.floor((bits - 4 - ccbits) / 8)
    return 'b'.repeat(Math.max(1, n - 1))
  }

  it.each(targets)('generates and round-trips version %i', async (version) => {
    const text = payloadForVersion(version, Ecc.MEDIUM)
    const { qr, result } = await renderAndScan(text, { version, ecc: 'M', boostEcc: false, mask: 3 }, { scale: 8 })
    expect(qr.version).toBe(version)
    expect(result.text).toBe(text)
  }, { timeout: 30_000 })

  it('round-trips every ECC level at v10', async () => {
    for (const ecc of ['L', 'M', 'Q', 'H'] as const) {
      const text = payloadForVersion(10, ECC_BY_LETTER[ecc])
      const { qr, result } = await renderAndScan(text, { version: 10, ecc, boostEcc: false })
      expect(qr.ecc).toBe(ecc)
      expect(result.text).toBe(text)
    }
  }, { timeout: 60_000 })
})

describe('renderers', () => {
  it('renders SVG', () => {
    const qr = generate('svg test')
    const svg = toSVG(qr, { scale: 2 })
    expect(svg).toContain('<svg')
    expect(svg).toContain('viewBox="0 0 ')
  })

  it('renders PNG and decodes it back', () => {
    const qr = generate('png test')
    const png = toPNG(qr, { scale: 3, border: 2 })
    const decoded = decodePNG(png)
    expect(decoded.width).toBe((qr.size + 4) * 3)
    expect(decoded.height).toBe((qr.size + 4) * 3)
    expect(decoded.data.length).toBe(decoded.width * decoded.height * 4)
  })

  it('renders data URL in Node', async () => {
    const qr = generate('data url test')
    const url = await toDataURL(qr)
    expect(url.startsWith('data:image/png;base64,')).toBe(true)
    const png = decodePNG(Uint8Array.from(atob(url.split(',')[1]), c => c.charCodeAt(0)))
    expect(png.width).toBe((qr.size + 8) * 4)
  })

  it('renders terminal half-blocks and full blocks', () => {
    const qr = generate('term test')
    const termSmall = toTerminal(qr)
    expect(termSmall).toContain('█')
    const termBig = toTerminal(qr, { small: false })
    expect(termBig).toContain('██')
    expect(toANSI(qr)).toBe(termSmall)
    expect(toUTF8(qr)).toBe(termSmall)
  })

  it('renders custom color & transparent PNG', async () => {
    const qr = generate('colored qr')
    const png = toPNG(qr, { color: '#0055ff', background: 'transparent' })
    const decoded = decodePNG(png)
    expect(decoded.data.length).toBe(decoded.width * decoded.height * 4)
    expect(decoded.data[3]).toBe(0)
  })
})

describe('generate format shortcuts', () => {
  it('generate(text, "png") returns PNG bytes', () => {
    const png = generate('https://example.com', 'png')
    expect(png).toBeInstanceOf(Uint8Array)
    expect(png[0]).toBe(0x89)
    expect(png[1]).toBe(0x50)
  })

  it('generate(text, "svg") returns an SVG string', () => {
    const svg = generate('https://example.com', 'svg')
    expect(svg.startsWith('<svg')).toBe(true)
  })

  it('generate(text, "data-url") returns a data URL', () => {
    const url = generate('https://example.com', 'data-url')
    expect(url.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('generate(text, "terminal") returns terminal string', () => {
    const term = generate('https://example.com', 'terminal')
    expect(typeof term).toBe('string')
    expect(term).toContain('█')
  })

  it('matches the equivalent render function output', () => {
    const png1 = generate('match', 'png', { scale: 2 })
    const png2 = toPNG(generate('match'), { scale: 2 })
    expect(png1).toEqual(png2)
  })
})

describe('center logo', () => {
  const logoBytes = readFileSync(resolve(__filename, '../fixtures/logo.png'))

  it('decodePNG handles RGBA PNGs with real filters and zlib compression', () => {
    const logo = decodePNG(logoBytes)
    expect(logo.width).toBe(16)
    expect(logo.height).toBe(16)
    expect(logo.data[0]).toBe(255)
    expect(logo.data[1]).toBe(0)
    expect(logo.data[2]).toBe(0)
    expect(logo.data[3]).toBe(255)
  })

  it('embeds the logo in the toImageData center', () => {
    const qr = generate('logo test', { ecc: 'H' })
    const { data, width } = toImageData(qr, { scale: 4, logo: logoBytes })
    const center = (Math.floor(width / 2) * width + Math.floor(width / 2)) * 4
    expect(data[center]).toBe(255)
    expect(data[center + 1]).toBe(0)
    expect(data[center + 2]).toBe(0)
  })

  it('toSVG embeds the logo as an image', () => {
    const qr = generate('logo svg')
    const svg = toSVG(qr, { logo: logoBytes })
    expect(svg).toContain('<image')
    expect(svg).toContain('data:image/png;base64,')
  })

  it('PNG with logo still scans to the payload', async () => {
    const { result } = await renderAndScan('logo round trip', { ecc: 'H' }, { logo: logoBytes, scale: 8 })
    expect(result.text).toBe('logo round trip')
  })

  it('accepts raw logo pixels too', () => {
    const pixels = decodePNG(logoBytes)
    const png = toPNG(generate('pixel logo'), { logo: pixels })
    expect(png[0]).toBe(0x89)
  })
})

describe('check and verify', () => {
  it('checks encodable text', () => {
    const result = check('hello world')
    expect(result.ok).toBe(true)
    expect(result.mode).toBe('byte')
    expect(result.version).toBeGreaterThanOrEqual(1)
    expect(result.requiredBits).toBeGreaterThan(0)
  })

  it('checks segments', () => {
    const segs = [QrSegment.makeNumeric('12345'), QrSegment.makeAlphanumeric('ABC')]
    const result = checkSegments(segs)
    expect(result.ok).toBe(true)
    expect(result.requiredBits).toBeGreaterThan(0)
  })

  it('checks oversize data fails', () => {
    const result = check('x'.repeat(3000))
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
  })

  it('checks forced mode mismatch', () => {
    const result = check('abc123', { mode: 'numeric' })
    expect(result.ok).toBe(false)
  })

  it('checks binary', () => {
    const result = checkBinary(new Uint8Array(100))
    expect(result.ok).toBe(true)
  })

  it('verifies a scanned image against expected text', async () => {
    const png = toPNG(generate('verify me'))
    const image = decodePNG(png)
    const result = await verify('verify me', image)
    expect(result.ok).toBe(true)
    const bad = await verify('wrong text', image)
    expect(bad.ok).toBe(false)
  })

  it('verifies generated QR round-trips', async () => {
    const qr = generate('round trip check สวัสดี 世界')
    const result = await verifyGenerated(qr)
    expect(result.ok).toBe(true)
    expect(result.text).toBe(qr.text)
  })

  it('scans the bundled fixture', async () => {
    const image = sharp(resolve(__filename, '../fixtures/1.png'))
      .ensureAlpha()
      .raw()
    const metadata = await image.metadata()
    const result = await scanQRData(
      Uint8ClampedArray.from(await image.toBuffer()),
      metadata.width!,
      metadata.height!,
    )
    expect(result.text).toBe('qrcode.antfu.me')
  }, { timeout: 30_000 })
})

describe('promptPay & billPayment', () => {
  it('generates payload for local phone number', () => {
    expect(promptPay('0801234567')).toBe('00020101021129370016A000000677010111011300668012345675802TH530376463046197')
    expect(promptPay('080-123-4567')).toBe('00020101021129370016A000000677010111011300668012345675802TH530376463046197')
  })

  it('generates payload for +66 phone number', () => {
    expect(promptPay('+66-89-123-4567')).toBe('00020101021129370016A000000677010111011300668912345675802TH5303764630429C1')
  })

  it('generates payload for national ID number', () => {
    expect(promptPay('1111111111111')).toBe('00020101021129370016A000000677010111021311111111111115802TH530376463047B5A')
    expect(promptPay('1-1111-11111-11-1')).toBe('00020101021129370016A000000677010111021311111111111115802TH530376463047B5A')
  })

  it('generates payload for tax ID number', () => {
    expect(promptPay('0123456789012')).toBe('00020101021129370016A000000677010111021301234567890125802TH530376463040CBD')
  })

  it('generates payload for e-wallet ID', () => {
    expect(promptPay('012345678901234')).toBe('00020101021129390016A00000067701011103150123456789012345802TH530376463049781')
  })

  it('generates payload with amount (dynamic QR)', () => {
    expect(promptPay('000-000-0000', { amount: 4.22 })).toBe('00020101021229370016A000000677010111011300660000000005802TH530376454044.226304E469')
  })

  it('validates PromptPay IDs', () => {
    expect(checkPromptPay('0812345678').ok).toBe(true)
    expect(checkPromptPay('0812345678').type).toBe('mobile')
    expect(checkPromptPay('1111111111111').type).toBe('nationalId')
    expect(checkPromptPay('012345678901234').type).toBe('ewalletId')
    expect(checkPromptPay('12345').ok).toBe(false)
    expect(checkPromptPay('abcd').ok).toBe(false)
  })

  it('validates amounts', () => {
    expect(checkPromptPay('0812345678', { amount: 0 }).ok).toBe(false)
    expect(checkPromptPay('0812345678', { amount: -5 }).ok).toBe(false)
    expect(checkPromptPay('0812345678', { amount: 200001 }).ok).toBe(false)
    expect(checkPromptPay('0812345678', { amount: 1.005 }).ok).toBe(false)
    expect(checkPromptPay('0812345678', { amount: 99.99 }).ok).toBe(true)
    expect(checkPromptPay('0812345678', { amount: 200000 }).ok).toBe(true)
    expect(checkPromptPay('0812345678', { amount: 50000, maxAmount: 10000 }).ok).toBe(false)
    expect(checkPromptPay('0812345678', { amount: 9999, maxAmount: 10000 }).ok).toBe(true)
  })

  it('parses PromptPay payloads with parsePromptPay and decodePromptPay', () => {
    const payload = promptPay('0812345678', { amount: 150 })
    const parsed = parsePromptPay(payload)
    expect(parsed.ok).toBe(true)
    expect(parsed.crcValid).toBe(true)
    expect(parsed.type).toBe('mobile')
    expect(parsed.formattedTarget).toBe('0812345678')
    expect(parsed.amount).toBe(150)
    expect(parsed.poiMethod).toBe('dynamic')
    expect(decodePromptPay(payload)).toEqual(parsed)
  })

  it('supports PromptPay Bill Payment', () => {
    const bpPayload = billPayment({ billerId: '010555800000000', ref1: 'INV12345', ref2: 'CUST001', amount: 500 })
    expect(bpPayload).toContain('30')
    const parsed = parsePromptPay(bpPayload)
    expect(parsed.ok).toBe(true)
    expect(parsed.crcValid).toBe(true)
    expect(parsed.type).toBe('billPayment')
    expect(parsed.billerId).toBe('010555800000000')
    expect(parsed.ref1).toBe('INV12345')
    expect(parsed.ref2).toBe('CUST001')
    expect(parsed.amount).toBe(500)

    const qr = generateBillPayment({ billerId: '010555800000000', ref1: 'INV12345' })
    expect(qr.version).toBeGreaterThanOrEqual(1)
  })

  it('generates a scannable PromptPay QR code', async () => {
    const qr = generatePromptPay('0812345678', { amount: 100 })
    expect(qr.mode).toBe('alphanumeric')
    const png = toPNG(qr, { scale: 6 })
    const image = decodePNG(png)
    const result = await scanQRData(image.data, image.width, image.height)
    expect(result.text).toBe(promptPay('0812345678', { amount: 100 }))
  }, { timeout: 30_000 })

  it('scanned payload CRC validates', async () => {
    const qr = generatePromptPay('1111111111111')
    const png = toPNG(qr, { scale: 6 })
    const image = decodePNG(png)
    const result = await scanQRData(image.data, image.width, image.height)
    const payload = result.text!
    expect(payload.slice(0, 2)).toBe('00')
    expect(payload.slice(-8, -4)).toBe('6304')
    const crc = Number.parseInt(payload.slice(-4), 16)
    let checkCrc = 0xFFFF
    for (let i = 0; i < payload.length - 4; i++) {
      checkCrc ^= payload.charCodeAt(i) << 8
      for (let j = 0; j < 8; j++)
        checkCrc = checkCrc & 0x8000 ? (checkCrc << 1) ^ 0x1021 : checkCrc << 1
      checkCrc &= 0xFFFF
    }
    expect(checkCrc).toBe(crc)
  }, { timeout: 30_000 })
})

describe('scanner & scanAll', () => {
  it('scanAll returns all detected QR codes in an image', async () => {
    const qr = generate('scan all test')
    const png = toPNG(qr, { scale: 4 })
    const image = decodePNG(png)
    const results = await scanAll(image)
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].text).toBe('scan all test')
    expect(results[0].rect).toBeDefined()
  }, { timeout: 30_000 })
})

describe('security & correctness fixes', () => {
  it('crc32 matches the standard CRC-32 check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xCBF43926)
  })

  it('parseColor handles all valid color formats and rejects bad ones', () => {
    expect(parseColor('#fff')).toEqual([255, 255, 255, 255])
    expect(parseColor('#00ff00')).toEqual([0, 255, 0, 255])
    expect(parseColor('#00ff0080')).toEqual([0, 255, 0, 128])
    expect(parseColor('transparent')).toEqual([0, 0, 0, 0])
    expect(parseColor('rgb(10, 20, 30)')).toEqual([10, 20, 30, 255])
    expect(parseColor('rgba(10, 20, 30, 0.5)')).toEqual([10, 20, 30, 128])
    expect(() => parseColor('invalid-color-123')).toThrow(/Invalid color/)
    expect(() => parseColor('" onload="alert(1)')).toThrow(/Invalid color/)
  })

  it('toSVG rejects non-hex / non-color strings', () => {
    const qr = generate('test')
    expect(() => toSVG(qr, { color: 'red' })).toThrow(/Invalid color/)
    expect(() => toSVG(qr, { color: '" onload="alert(1)' })).toThrow(/Invalid color/)
    expect(() => toSVG(qr, { background: 'url(javascript:alert(1))' })).toThrow(/Invalid color/)
    expect(() => toSVG(qr, { color: '#ff0000' })).not.toThrow()
    expect(() => toSVG(qr, { color: 'ff0000' })).not.toThrow()
  })

  it('decodePNG rejects oversized IHDR dimensions', () => {
    const qr = generate('test')
    const png = toPNG(qr, { scale: 4 })
    const patched = new Uint8Array(png)
    const view = new DataView(patched.buffer)
    view.setUint32(16, 99999, false)
    view.setUint32(20, 99999, false)
    expect(() => decodePNG(patched)).toThrow(/dimensions/)
  })

  it('generate handles lone surrogates without throwing', async () => {
    const { result } = await renderAndScan('a\uD800b')
    expect(result.text).toBe('a\uFFFDb')
  }, { timeout: 30_000 })
})

describe('second-pass fixes', () => {
  it('promptPay() validates IDs directly (no silent garbage)', () => {
    expect(() => promptPay('812345678')).toThrow(/Invalid mobile number/)
    expect(() => promptPay('0801234567', { amount: 1e21 })).toThrow(/exceeds/)
    expect(() => promptPay('0801234567', { amount: 100.001 })).toThrow(/decimal/)
  })

  it('accepts float amounts within epsilon', () => {
    expect(promptPay('0812345678', { amount: 0.1 + 0.2 })).toContain('54040.30')
  })

  it('generate() does not accept mode kanji (use generateKanji)', () => {
    expect(() => generate('foo', { mode: 'kanji' as any })).toThrow(/Invalid mode/)
  })

  it('scan() returns null text when no QR is found', async () => {
    const blank = { data: new Uint8ClampedArray(64 * 64 * 4).fill(255), width: 64, height: 64 }
    const result = await scan(blank)
    expect(result.text).toBeNull()
    expect(result.rect).toBeUndefined()
  }, { timeout: 30_000 })

  it('scan() with includeRectCanvas throws a clear error in Node', async () => {
    const qr = generate('rect-canvas')
    const png = toPNG(qr, { scale: 4 })
    const image = decodePNG(png)
    await expect(scan(image, { includeRectCanvas: true })).rejects.toThrow(/browsers/)
  }, { timeout: 30_000 })

  it('scan() rejects oversized images before WASM processing', async () => {
    await expect(scan({ data: new Uint8ClampedArray(1), width: 99999, height: 99999 })).rejects.toThrow(/limit/)
    await expect(scan({ data: new Uint8ClampedArray(1), width: 0, height: 0 })).rejects.toThrow(/dimensions/)
  })

  it('makeKanji rejects pairs overflowing the 13-bit coded value', () => {
    expect(() => QrSegment.makeKanji([0x82, 0xA0])).not.toThrow()
    expect(() => QrSegment.makeKanji([0xEB, 0xBF])).not.toThrow()
    expect(() => QrSegment.makeKanji([0xEB, 0xC0])).toThrow(/Invalid Shift_JIS/)
  })

  it('decodePNG rejects corrupted IDAT (Adler-32 mismatch)', () => {
    const qr = generate('adler-check')
    const png = toPNG(qr, { scale: 4 })
    const corrupted = new Uint8Array(png)
    corrupted[200] ^= 0xFF
    expect(() => decodePNG(corrupted)).toThrow(/Adler/)
  })

  it('parseColor and toSVG accept 3-digit hex', () => {
    const qr = generate('short-hex')
    expect(() => toSVG(qr, { color: '#fff' })).not.toThrow()
    expect(() => toImageData(qr, { background: '#000' })).not.toThrow()
  })

  it('toImageData rejects oversized renders', () => {
    const qr = generate('big-render')
    expect(() => toImageData(qr, { scale: 300 })).toThrow(/limit/)
  })
})

describe('third-pass fixes (report-3)', () => {
  it('toPNG/toSVG/toImageData reject scale < 1 and negative border', () => {
    const qr = generate('scale-zero')
    expect(() => toPNG(qr, { scale: 0 })).toThrow(/Invalid scale/)
    expect(() => toSVG(qr, { scale: 0 })).toThrow(/Invalid scale/)
    expect(() => toImageData(qr, { scale: 0 })).toThrow(/Invalid scale/)
    expect(() => toPNG(qr, { scale: 0.5 })).toThrow(/Invalid scale/)
    expect(() => toPNG(qr, { border: -1 })).toThrow(/Invalid border/)
    expect(() => toSVG(qr, { border: -1 })).toThrow(/Invalid border/)
    expect(() => toPNG(qr, { scale: 1, border: 0 })).not.toThrow()
    expect(() => toSVG(qr, { scale: 4, border: 4 })).not.toThrow()
  })

  it('generate() format shortcut rejects scale 0', () => {
    expect(() => generate('x', 'png', { scale: 0 })).toThrow(/Invalid scale/)
  })

  it('decodePNG rejects an out-of-range deflate back-reference', () => {
    const crcOf = (type: string, data: Uint8Array) => {
      const buf = new Uint8Array(4 + data.length)
      for (let i = 0; i < 4; i++)
        buf[i] = type.charCodeAt(i)
      buf.set(data, 4)
      return crc32(buf)
    }
    const chunk = (type: string, data: Uint8Array) => {
      const out = new Uint8Array(12 + data.length)
      new DataView(out.buffer).setUint32(0, data.length, false)
      for (let i = 0; i < 4; i++)
        out[4 + i] = type.charCodeAt(i)
      out.set(data, 8)
      new DataView(out.buffer).setUint32(8 + data.length, crcOf(type, data), false)
      return out
    }
    const ihdr = new Uint8Array(13)
    const view = new DataView(ihdr.buffer)
    view.setUint32(0, 1, false)
    view.setUint32(4, 1, false)
    ihdr[8] = 8
    ihdr[9] = 2
    const idat = Uint8Array.from([0x78, 0x9C, 0x03, 0x5E, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01])
    const sig = Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    const parts = [chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))]
    const png = new Uint8Array(sig.length + parts.reduce((n, c) => n + c.length, 0))
    png.set(sig)
    let offset = sig.length
    for (const part of parts) {
      png.set(part, offset)
      offset += part.length
    }
    expect(() => decodePNG(png)).toThrow(/back-reference distance/)
  })

  it('decodePNG decodes indexed color PNG with PLTE palette and tRNS alpha', () => {
    const crcOf = (type: string, data: Uint8Array) => {
      const buf = new Uint8Array(4 + data.length)
      for (let i = 0; i < 4; i++)
        buf[i] = type.charCodeAt(i)
      buf.set(data, 4)
      return crc32(buf)
    }
    const chunk = (type: string, data: Uint8Array) => {
      const out = new Uint8Array(12 + data.length)
      new DataView(out.buffer).setUint32(0, data.length, false)
      for (let i = 0; i < 4; i++)
        out[4 + i] = type.charCodeAt(i)
      out.set(data, 8)
      new DataView(out.buffer).setUint32(8 + data.length, crcOf(type, data), false)
      return out
    }
    const ihdr = new Uint8Array(13)
    const view = new DataView(ihdr.buffer)
    view.setUint32(0, 2, false)
    view.setUint32(4, 2, false)
    ihdr[8] = 8
    ihdr[9] = 3

    const plte = Uint8Array.from([
      255, 0, 0,
      0, 255, 0,
      0, 0, 255,
      255, 255, 0,
    ])
    const trns = Uint8Array.from([255, 128, 0, 255])
    const rawData = Uint8Array.from([0, 0, 1, 0, 2, 3])
    const len = rawData.length
    const nlen = (~len) & 0xFFFF
    const adlerData = (() => {
      let a = 1
      let b = 0
      for (let i = 0; i < rawData.length; i++) {
        a = (a + rawData[i]) % 65521
        b = (b + a) % 65521
      }
      return ((b << 16) | a) >>> 0
    })()
    const idat = Uint8Array.from([
      0x78, 0x01,
      0x01, len & 0xFF, (len >> 8) & 0xFF, nlen & 0xFF, (nlen >> 8) & 0xFF,
      ...rawData,
      (adlerData >>> 24) & 0xFF, (adlerData >>> 16) & 0xFF, (adlerData >>> 8) & 0xFF, adlerData & 0xFF,
    ])

    const sig = Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    const parts = [
      chunk('IHDR', ihdr),
      chunk('PLTE', plte),
      chunk('tRNS', trns),
      chunk('IDAT', idat),
      chunk('IEND', new Uint8Array(0)),
    ]
    const png = new Uint8Array(sig.length + parts.reduce((n, c) => n + c.length, 0))
    png.set(sig)
    let offset = sig.length
    for (const part of parts) {
      png.set(part, offset)
      offset += part.length
    }
    const decoded = decodePNG(png)
    expect(decoded.width).toBe(2)
    expect(decoded.height).toBe(2)
    expect(decoded.data[0]).toBe(255)
    expect(decoded.data[1]).toBe(0)
    expect(decoded.data[2]).toBe(0)
    expect(decoded.data[3]).toBe(255)
    expect(decoded.data[4]).toBe(0)
    expect(decoded.data[5]).toBe(255)
    expect(decoded.data[6]).toBe(0)
    expect(decoded.data[7]).toBe(128)
    expect(decoded.data[8]).toBe(0)
    expect(decoded.data[9]).toBe(0)
    expect(decoded.data[10]).toBe(255)
    expect(decoded.data[11]).toBe(0)
  })
})
