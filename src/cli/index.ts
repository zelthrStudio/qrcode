#!/usr/bin/env node
/* eslint-disable no-console */
import fs from 'node:fs/promises'
import process from 'node:process'
import readline from 'node:readline/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type QRCodeData, generate, toDataURL, toPNG, toSVG } from '../generate'
import { promptPay } from '../promptpay'

interface CliOptions {
  text?: string
  format: 'svg' | 'png' | 'data-url' | 'terminal'
  output?: string
  scale?: number
  border?: number
  ecc?: 'L' | 'M' | 'Q' | 'H'
  mask?: number
  minVersion?: number
  maxVersion?: number
  boostEcc: boolean
  eci?: number
  promptpay?: string
  amount?: number
  maxAmount?: number
  quiet: boolean
  help: boolean
  version: boolean
}

const USAGE = `Usage: qrcode [text] [options]

Generate a QR Code and print it or save it to a file.

Arguments:
  text                      Text to encode (or pipe it via stdin)

PromptPay:
  -p, --promptpay <phone>   Generate a PromptPay QR for this phone number
      --amount <baht>       Amount to request
      --max-amount <baht>   Max amount (for non-fixed amount requests)

Output:
  -f, --format <fmt>        svg | png | data-url | terminal (default: terminal)
  -o, --output <file>       Write to a file instead of stdout

Options:
  -s, --scale <n>           Modules per pixel (default: 4)
  -b, --border <n>          Quiet zone in modules (default: 4)
  -e, --ecc <L|M|Q|H>       Error correction level (default: M)
  -m, --mask <0-7|-1>       Force a mask pattern (default: -1)
      --min-version <1-40>  Smallest version (default: 1)
      --max-version <1-40>  Largest version (default: 40)
      --no-boost-ecc        Don't boost ECC without growing the version
      --eci <n>             ECI designator (e.g. 26 for UTF-8)
  -q, --quiet               Don't prompt; use defaults
  -h, --help                Show this help
  -v, --version             Show the version

Examples:
  qrcode "https://example.com"
  qrcode "hello" -f svg -o qr.svg
  qrcode -p 0812345678 --amount 150 -f png -o qr.png
  cat payload.txt | qrcode -f terminal`

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    format: 'terminal',
    boostEcc: true,
    quiet: false,
    help: false,
    version: false,
  }
  const positionals: string[] = []
  const value = (flag: string, i: number): string | undefined => {
    const inline = argv[i].match(/^--[\w-]+=(.+)$/)
    if (inline)
      return inline[1]
    return argv[i + 1]
  }
  const number = (flag: string, i: number): number => {
    const raw = value(flag, i)
    if (raw === undefined)
      throw new Error(`Missing value for ${flag}`)
    const n = Number(raw)
    if (!Number.isFinite(n))
      throw new Error(`Invalid number for ${flag}: ${raw}`)
    return n
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '-f':
      case '--format': {
        const v = value(arg, i)
        if (!v || !['svg', 'png', 'data-url', 'terminal'].includes(v))
          throw new Error(`Invalid format: ${v} (expected svg, png, data-url or terminal)`)
        options.format = v as CliOptions['format']
        if (!arg.includes('='))
          i++
        break
      }
      case '-o':
      case '--output': {
        options.output = value(arg, i)
        if (!arg.includes('='))
          i++
        break
      }
      case '-s':
      case '--scale': {
        options.scale = number(arg, i)
        if (!arg.includes('='))
          i++
        break
      }
      case '-b':
      case '--border': {
        options.border = number(arg, i)
        if (!arg.includes('='))
          i++
        break
      }
      case '-e':
      case '--ecc': {
        const v = value(arg, i)
        if (!v || !['L', 'M', 'Q', 'H'].includes(v))
          throw new Error(`Invalid ECC level: ${v} (expected L, M, Q or H)`)
        options.ecc = v as CliOptions['ecc']
        if (!arg.includes('='))
          i++
        break
      }
      case '-m':
      case '--mask': {
        options.mask = number(arg, i)
        if (!arg.includes('='))
          i++
        break
      }
      case '--min-version': {
        options.minVersion = number(arg, i)
        if (!arg.includes('='))
          i++
        break
      }
      case '--max-version': {
        options.maxVersion = number(arg, i)
        if (!arg.includes('='))
          i++
        break
      }
      case '--no-boost-ecc':
        options.boostEcc = false
        break
      case '--eci': {
        options.eci = number(arg, i)
        if (!arg.includes('='))
          i++
        break
      }
      case '-p':
      case '--promptpay': {
        options.promptpay = value(arg, i)
        if (!arg.includes('='))
          i++
        break
      }
      case '--amount': {
        options.amount = number(arg, i)
        if (!arg.includes('='))
          i++
        break
      }
      case '--max-amount': {
        options.maxAmount = number(arg, i)
        if (!arg.includes('='))
          i++
        break
      }
      case '-q':
      case '--quiet':
        options.quiet = true
        break
      case '-h':
      case '--help':
        options.help = true
        break
      case '-v':
      case '--version':
        options.version = true
        break
      default:
        if (arg.startsWith('-'))
          throw new Error(`Unknown option: ${arg}`)
        positionals.push(arg)
    }
  }

  if (positionals.length > 1)
    throw new Error(`Unexpected extra argument: ${positionals.slice(1).join(' ')}`)
  if (positionals.length === 1)
    options.text = positionals[0]
  return options
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => data += chunk)
    process.stdin.on('end', () => resolve(data.trim()))
  })
}

async function prompt(options: CliOptions): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const modeAnswer = await rl.question('What do you want to encode? (1) text  (2) PromptPay  [1]: ')
    const mode = modeAnswer.trim() === '2' ? 'promptpay' : 'text'
    if (mode === 'promptpay') {
      options.promptpay = (await rl.question('Phone number: ')).trim()
      const amount = (await rl.question('Amount in THB (Enter to skip): ')).trim()
      if (amount)
        options.amount = Number(amount)
    }
    else {
      options.text = await rl.question('Text to encode: ')
    }
    const format = (await rl.question('Format svg / png / data-url / terminal  [terminal]: ')).trim().toLowerCase()
    if (['svg', 'png', 'data-url', 'terminal'].includes(format))
      options.format = format as CliOptions['format']
    if (options.format !== 'terminal') {
      const output = (await rl.question('Output file (Enter to print): ')).trim()
      if (output)
        options.output = output
    }
  }
  finally {
    rl.close()
  }
}

function renderTerminal(qr: QRCodeData, border: number): string {
  const size = qr.size + border * 2
  const block = (top: boolean, bottom: boolean) => (top ? (bottom ? '█' : '▀') : (bottom ? '▄' : ' '))
  const rows: string[] = [' '.repeat(size)]
  for (let y = 0; y < qr.size; y += 2) {
    let line = ''
    for (let x = -border; x < qr.size + border; x++) {
      const topDark = x >= 0 && y >= 0 && x < qr.size && y < qr.size && qr.matrix[y * qr.size + x] === 1
      const bottomDark = x >= 0 && y + 1 >= 0 && x < qr.size && y + 1 < qr.size && qr.matrix[(y + 1) * qr.size + x] === 1
      line += block(topDark, bottomDark)
    }
    rows.push(line)
  }
  if (qr.size % 2 === 1)
    rows.push(' '.repeat(size))
  rows.push(' '.repeat(size))
  return rows.join('\n')
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))

  if (options.help) {
    console.log(USAGE)
    return
  }
  if (options.version) {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8')) as { version: string }
    console.log(pkg.version)
    return
  }

  const stdinIsTTY = Boolean(process.stdin.isTTY)
  if (!options.text && !options.promptpay && !stdinIsTTY && !options.quiet) {
    const piped = await readStdin()
    if (piped)
      options.text = piped
  }
  if (!options.text && !options.promptpay) {
    if (stdinIsTTY)
      await prompt(options)
    else
      throw new Error('No input: pass text as an argument or pipe it via stdin')
  }

  let text: string
  if (options.promptpay) {
    const { amount, maxAmount } = options
    text = promptPay(options.promptpay, amount !== undefined || maxAmount !== undefined
      ? { ...(amount !== undefined ? { amount } : {}), ...(maxAmount !== undefined ? { maxAmount } : {}) }
      : {})
  }
  else {
    text = options.text!
  }

  const { scale, border, ecc, mask, minVersion, maxVersion, boostEcc, eci } = options
  const qr = generate(text, {
    ...(ecc ? { ecc } : {}),
    ...(mask !== undefined ? { mask } : {}),
    ...(minVersion !== undefined ? { minVersion } : {}),
    ...(maxVersion !== undefined ? { maxVersion } : {}),
    ...(boostEcc ? {} : { boostEcc: false }),
    ...(eci !== undefined ? { eci } : {}),
  })
  const renderOptions = {
    ...(scale !== undefined ? { scale } : {}),
    ...(border !== undefined ? { border } : {}),
  }

  const stdoutIsTTY = Boolean(process.stdout.isTTY)
  const content = await render(qr, options, renderOptions)
  if (options.output) {
    await fs.writeFile(options.output, content)
    if (stdoutIsTTY)
      console.error(`Written to ${options.output}`)
  }
  else if (options.format === 'png') {
    if (stdoutIsTTY)
      throw new Error('PNG output is binary: use --output <file> or pipe stdout to a file')
    process.stdout.write(content as Uint8Array)
  }
  else {
    console.log(content)
  }
}

async function render(qr: QRCodeData, options: CliOptions, renderOptions: { scale?: number; border?: number }): Promise<string | Uint8Array> {
  switch (options.format) {
    case 'svg':
      return toSVG(qr, renderOptions)
    case 'png':
      return toPNG(qr, renderOptions)
    case 'data-url':
      return toDataURL(qr, renderOptions)
    case 'terminal':
      return renderTerminal(qr, renderOptions.border ?? 4)
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`qrcode: ${message}`)
  console.error('Run \'qrcode --help\' for usage.')
  process.exitCode = 1
})
