# @zelthr/qrcode

QR Code **scanner** and **generator** for JavaScript — one library for everything QR.

- **Scan** — powered by a WebAssembly build of [OpenCV](https://opencv.org/) with the [WeChat QR Code Scanner](https://docs.opencv.org/4.5.4/d5/d04/classcv_1_1wechat__qrcode_1_1WeChatQRCode.html) model, giving a much better detection rate and error tolerance. Works in browsers and Node.js.
- **Generate** — dependency-free encoder supporting **all** QR Code Model 2 formats:
  - All versions 1–40
  - All 4 error correction levels (L / M / Q / H)
  - All 4 data modes: numeric, alphanumeric, byte (UTF-8), kanji (Shift_JIS / JIS X 0208)
  - All 8 mask patterns (+ automatic selection), ECI support, segment-level control
- **Check** — validate payloads and verify codes round-trip (generate → scan → compare).

## Install

```bash
npm i @zelthr/qrcode
```

## Scan

```ts
import { scan } from '@zelthr/qrcode'

const result = await scan(canvas) // Or HTMLImageElement / ImageData

console.log(result.text) // decoded string, or null
console.log(result.rect) // detection rectangle, if found
```

Upon the first call of `scan`, around **2.5 MB gzipped** of WebAssembly and models load asynchronously. Preload them with `ready()`:

```ts
import { ready, scan } from '@zelthr/qrcode'

await ready()
const result = await scan(canvas)
```

### Scanning a camera stream

```ts
const stream = await navigator.mediaDevices.getUserMedia({
  audio: false,
  video: { width: 512, height: 512 },
})

const video = document.getElementById('video')
video.srcObject = stream
video.play()

async function scanFrame() {
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  const ctx = canvas.getContext('2d')
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

  const result = await scan(canvas)
  if (result?.text)
    alert(result.text)
}

setInterval(scanFrame, 100)
```

### Scanning in Node.js

Pass an [`ImageData`](https://developer.mozilla.org/en-US/docs/Web/API/ImageData)-compatible object. Using [`sharp`](https://github.com/lovell/sharp):

```ts
import { scan } from '@zelthr/qrcode'
import sharp from 'sharp'

const image = sharp('/path/to/image.png') // or Buffer, anything sharp supports
const { data, info } = await image
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true })

const result = await scan({
  data: Uint8ClampedArray.from(data),
  width: info.width,
  height: info.height,
})
```

## Generate

```ts
import { generate, toSVG, toDataURL } from '@zelthr/qrcode'

const qr = generate('https://example.com')
// { text, version, size, ecc, mask, mode, matrix, dataCapacity }

const svg = toSVG(qr) // string
const dataURL = await toDataURL(qr) // data:image/png;base64,...

const canvas = toCanvas(qr) // browser only
const { data, width } = toImageData(qr) // RGBA pixels
const png = toPNG(qr) // Uint8Array, dependency-free PNG
```

### Options

```ts
generate('HELLO', {
  ecc: 'H',            // 'L' | 'M' | 'Q' | 'H', default 'M'
  mode: 'byte',        // 'auto' | 'numeric' | 'alphanumeric' | 'byte', default 'auto'
  version: 5,          // force version 1-40, default: smallest that fits
  minVersion: 1,       // version range limits
  maxVersion: 40,
  mask: 3,             // force mask 0-7, or -1 for automatic, default -1
  boostEcc: false,     // boost ECC without growing the version, default true
  eci: 26,             // ECI designator, e.g. 26 = UTF-8
})

generateBinary(new Uint8Array([1, 2, 3]))   // raw bytes, max 2953
generateKanji([0x82, 0xA0])                 // kanji mode from Shift_JIS bytes
```

Rendering options (`toSVG` / `toPNG` / `toDataURL` / `toCanvas` / `toImageData`):

```ts
toSVG(qr, {
  scale: 4,          // modules per pixel, default 4
  border: 4,         // quiet zone in modules, default 4
  color: '#000000',  // dark modules
  background: '#ffffff',
})
```

## Check & verify

```ts
import { check, verify, verifyGenerated } from '@zelthr/qrcode'

// Validate that a payload can be encoded, and see which format is used
const info = check('hello')  // { ok, mode, version, size, capacity }
const tooBig = check('x'.repeat(3000))  // { ok: false, error }

// Scan an image and confirm it decodes to the expected text
const ok = await verify('https://example.com', image)

// Round-trip: render a generated QR to pixels, scan it back, compare
const qr = generate('สวัสดี')
const verified = await verifyGenerated(qr)  // { ok, text, expected }
```

## PromptPay (Thai QR payment)

Generate EMVCo / Bank of Thailand PromptPay QR codes with zero dependencies
(CRC-16 computed in-house). Supported PromptPay IDs: mobile numbers, national
ID / tax ID (13 digits) and e-wallet IDs (15 digits).

```ts
import { promptPay, generatePromptPay, toSVG } from '@zelthr/qrcode'

// Raw EMVCo payload (ready to encode), static QR
const payload = promptPay('081-234-5678')
// "00020101021129370016A00000067701011101130066812345678..."

// With a transfer amount (dynamic QR)
const payload = promptPay('1111111111111', { amount: 99.50 })

// Straight to a renderable QR Code
const qr = generatePromptPay('0812345678', { amount: 100, ecc: 'H' })
const svg = toSVG(qr)
```

Validation (ID format + amount rules):

```ts
import { checkPromptPay } from '@zelthr/qrcode'

checkPromptPay('0812345678')                       // { ok: true, type: 'mobile', ... }
checkPromptPay('1111111111111')                    // { ok: true, type: 'nationalId' }
checkPromptPay('012345678901234')                  // { ok: true, type: 'ewalletId' }
checkPromptPay('123')                              // { ok: false, error: 'Invalid mobile number: 123' }
checkPromptPay('0812345678', { amount: 200001 })   // { ok: false, error: 'Amount exceeds 200000 Baht limit' }
checkPromptPay('0812345678', { amount: 50000, maxAmount: 10000 }) // custom limit
```

Amounts are limited to 0 < amount ≤ 200,000 Baht (current BOT PromptPay limit)
with at most 2 decimal places. Override the limit per call with `maxAmount`.

## Supported formats

| Aspect | Support |
| --- | --- |
| Versions | 1 – 40 (auto or forced) |
| Error correction | L (7%), M (15%), Q (25%), H (30%) — auto-boostable |
| Modes | numeric, alphanumeric, byte (UTF-8), kanji (JIS X 0208), ECI |
| Masks | 0 – 7, automatic selection by penalty score |
| Payload | text up to 7089 chars (numeric), binary up to 2953 bytes |
| PromptPay | EMVCo Thai payment QR (mobile / national ID / tax ID / e-wallet, optional amount) |
| Runtimes | browsers + Node.js (canvas optional, PNG built-in) |

## Dependencies

Zero runtime dependencies — the encoder, PNG encoder/decoder, CRC-16 and
PromptPay payload generator are all built-in. The scanner bundles its own
OpenCV WebAssembly build and WeChat QR detection models.

## License

[MIT](./LICENSE) © zelthr. QR encoder algorithm and tables ported from the
[QR Code generator library](https://www.nayuki.io/page/qr-code-generator-library)
by Project Nayuki (MIT). Scanner engine based on [qr-scanner-wechat](https://github.com/antfu/qr-scanner-wechat)
(OpenCV WASM + WeChat QR model). PromptPay payload structure based on
[dtinth/promptpay-qr](https://github.com/dtinth/promptpay-qr) (MIT).