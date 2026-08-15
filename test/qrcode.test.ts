import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { check, checkBinary, checkPromptPay, crc32, decodePNG, generate, generateBinary, generatePromptPay, promptPay, scan, toDataURL, toImageData, toPNG, toSVG, verify, verifyGenerated } from '../src'
import { Ecc, Mode, QrCode, QrSegment } from '../src/generate/qrcodegen'

const __filename = fileURLToPath(import.meta.url)
const ECC_BY_LETTER = { L: Ecc.LOW, M: Ecc.MEDIUM, Q: Ecc.QUARTILE, H: Ecc.HIGH } as const

async function scanQRData(data: Uint8ClampedArray, width: number, height: number) {
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
})

describe('check and verify', () => {
  it('checks encodable text', () => {
    const result = check('hello world')
    expect(result.ok).toBe(true)
    expect(result.mode).toBe('byte')
    expect(result.version).toBeGreaterThanOrEqual(1)
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

describe('promptPay', () => {
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
    let check = 0xFFFF
    for (let i = 0; i < payload.length - 4; i++) {
      check ^= payload.charCodeAt(i) << 8
      for (let j = 0; j < 8; j++)
        check = check & 0x8000 ? (check << 1) ^ 0x1021 : check << 1
      check &= 0xFFFF
    }
    expect(check).toBe(crc)
  }, { timeout: 30_000 })
})

describe('security & correctness fixes', () => {
  it('crc32 matches the standard CRC-32 check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xCBF43926)
  })

  it('toSVG rejects non-hex colors (SVG injection)', () => {
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

  it('hexToRgb accepts 3-digit hex', () => {
    const qr = generate('short-hex')
    expect(() => toSVG(qr, { color: '#fff' })).not.toThrow()
    expect(() => toImageData(qr, { background: '#000' })).not.toThrow()
  })

  it('toImageData rejects oversized renders', () => {
    const qr = generate('big-render')
    expect(() => toImageData(qr, { scale: 300 })).toThrow(/limit/)
  })
})
