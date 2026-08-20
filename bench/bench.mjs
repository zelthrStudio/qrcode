/* eslint-disable no-console */
import { decodePNG, generate, toDataURL, toImageData, toPNG, toSVG } from '../src/index.ts'

function bench(name, fn, iterations = 1000) {
  // warmup
  for (let i = 0; i < Math.min(50, iterations); i++) fn()
  const start = performance.now()
  for (let i = 0; i < iterations; i++) fn()
  const elapsed = performance.now() - start
  const opsPerSec = Math.round(iterations / (elapsed / 1000))
  console.log(`${name.padEnd(40)} ${elapsed.toFixed(1).padStart(8)}ms  (${opsPerSec.toLocaleString()} ops/s)`)
  return elapsed
}

const text = 'https://example.com/some/long/path?query=value&foo=bar'
const qr = generate(text)
const qrLarge = generate('x'.repeat(500))

console.log('--- generate ---')
bench('generate(short url)', () => generate(text))
bench('generate(500 chars)', () => generate('x'.repeat(500)))

console.log('--- render ---')
bench('toPNG(short, scale 4)', () => toPNG(qr, { scale: 4 }))
bench('toPNG(large, scale 4)', () => toPNG(qrLarge, { scale: 4 }))
bench('toPNG(short, scale 8)', () => toPNG(qr, { scale: 8 }))
bench('toSVG(short)', () => toSVG(qr))
bench('toImageData(short, scale 4)', () => toImageData(qr, { scale: 4 }))
bench('toDataURL(short)', () => toDataURL(qr))

console.log('--- decode ---')
const png = toPNG(qr, { scale: 4 })
const pngLarge = toPNG(qrLarge, { scale: 4 })
bench('decodePNG(short png)', () => decodePNG(png))
bench('decodePNG(large png)', () => decodePNG(pngLarge))
