import { generate, toPNG, scan, decodePNG, promptPay, verify, ready } from './dist/index.mjs'

function crc16(data) {
  let crc = 0xffff
  for (const byte of data) {
    crc ^= byte << 8
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1
      crc &= 0xffff
    }
  }
  return crc
}

await ready()

const qr = generate('hello dist smoke test')
const png = toPNG(qr, { scale: 6 })
const image = decodePNG(png)
const scanned = await scan(image)
console.log('scan round-trip:', scanned.text === 'hello dist smoke test' ? 'OK' : 'FAIL')

const expected = '00020101021229370016A000000677010111011300668123456785802TH53037645406150.006304CC46'
const pp = promptPay('0812345678', { amount: 150 })
console.log('promptpay payload:', pp === expected ? 'OK' : 'FAIL')
console.log('promptpay CRC:', crc16(new TextEncoder().encode(pp.slice(0, -4))) === parseInt(pp.slice(-4), 16) ? 'OK' : 'FAIL')

const ppImg = decodePNG(toPNG(generate(pp), { scale: 6 }))
const ppScan = await scan(ppImg)
console.log('promptpay scan round-trip:', ppScan.text === pp ? 'OK' : 'FAIL')
console.log('verify:', (await verify(pp, ppImg)).ok ? 'OK' : 'FAIL')

const blank = { data: new Uint8ClampedArray(64 * 64 * 4).fill(255), width: 64, height: 64 }
const none = await scan(blank)
console.log('blank -> null:', none.text === null ? 'OK' : 'FAIL')