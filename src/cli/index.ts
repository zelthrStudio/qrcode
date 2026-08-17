#!/usr/bin/env node
/* eslint-disable no-console */
import fs from 'node:fs/promises'
import process from 'node:process'
import readline from 'node:readline/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type QRCodeData, type RenderOptions, decodePNG, generate, toDataURL, toPNG, toSVG, toTerminal } from '../generate'
import { MAX_PROMPTPAY_AMOUNT, promptPay } from '../promptpay'
import { scan } from '../scan'

interface CliOptions {
  text?: string
  format?: 'svg' | 'png' | 'data-url' | 'terminal' | 'utf8'
  output?: string
  logo?: string
  color?: string
  background?: string
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
  scan?: string
  quiet: boolean
  help: boolean
  version: boolean
}

const USAGE = `Usage: qrcode [text] [options]

Generate a QR Code and print it or save it to a file, or scan an existing QR Code image.

Arguments:
  text                      Text to encode (or pipe it via stdin)

Scanning:
  -d, --scan <file>         Scan a PNG image file and print the decoded text

PromptPay:
  -p, --promptpay <phone>   Generate a PromptPay QR for this phone number
      --amount <baht>       Amount to request
      --max-amount <baht>   Max transfer limit (default: ${MAX_PROMPTPAY_AMOUNT} Baht)

Output:
  -f, --format <fmt>        terminal | svg | png | data-url (default: terminal in TTY, svg if piped)
  -o, --output <file>       Write to a file instead of stdout
      --logo <file>         Embed a PNG image in the center of the QR Code
  -c, --color <color>       Module color (hex / rgb / named, default: #000000)
      --background <color>  Background color (hex / rgb / transparent, default: #ffffff)

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
  qrcode "hello" --color "#0055ff" --background transparent -f png -o qr.png
  qrcode -p 0812345678 --amount 150 -f png -o qr.png
  qrcode --scan qr.png
  cat payload.txt | qrcode -f svg -o qr.svg`

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
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
        if (!v || !['svg', 'png', 'data-url', 'terminal', 'utf8'].includes(v))
          throw new Error(`Invalid format: ${v} (expected terminal, svg, png or data-url)`)
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
      case '-d':
      case '--scan': {
        options.scan = value(arg, i)
        if (!arg.includes('='))
          i++
        break
      }
      case '--logo': {
        options.logo = value(arg, i)
        if (!arg.includes('='))
          i++
        break
      }
      case '-c':
      case '--color': {
        options.color = value(arg, i)
        if (!arg.includes('='))
          i++
        break
      }
      case '--background': {
        options.background = value(arg, i)
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
    const format = (await rl.question('Format terminal / svg / png / data-url  [terminal]: ')).trim().toLowerCase()
    if (['terminal', 'svg', 'png', 'data-url', 'utf8'].includes(format))
      options.format = format as CliOptions['format']
    const output = (await rl.question('Output file (Enter to print): ')).trim()
    if (output)
      options.output = output
    const logo = (await rl.question('Logo PNG file (Enter to skip): ')).trim()
    if (logo)
      options.logo = logo
  }
  finally {
    rl.close()
  }
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

  if (options.scan) {
    const fileBytes = await fs.readFile(options.scan)
    const image = decodePNG(fileBytes)
    const result = await scan(image)
    if (result.text !== null) {
      console.log(result.text)
    }
    else {
      console.error('No QR code found in image')
      process.exitCode = 1
    }
    return
  }

  const stdinIsTTY = Boolean(process.stdin.isTTY)
  const stdoutIsTTY = Boolean(process.stdout.isTTY)

  if (!options.format)
    options.format = (!options.output && stdoutIsTTY) ? 'terminal' : 'svg'

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

  const { scale, border, ecc, mask, minVersion, maxVersion, boostEcc, eci, color, background } = options
  const qr = generate(text, {
    ...(ecc ? { ecc } : {}),
    ...(mask !== undefined ? { mask } : {}),
    ...(minVersion !== undefined ? { minVersion } : {}),
    ...(maxVersion !== undefined ? { maxVersion } : {}),
    ...(boostEcc ? {} : { boostEcc: false }),
    ...(eci !== undefined ? { eci } : {}),
  })
  const renderOptions: RenderOptions = {
    ...(scale !== undefined ? { scale } : {}),
    ...(border !== undefined ? { border } : {}),
    ...(color ? { color } : {}),
    ...(background ? { background } : {}),
    ...(options.logo ? { logo: decodePNG(await fs.readFile(options.logo)) } : {}),
  }

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

async function render(qr: QRCodeData, options: CliOptions, renderOptions: RenderOptions): Promise<string | Uint8Array> {
  switch (options.format) {
    case 'terminal':
    case 'utf8':
      return toTerminal(qr, { border: renderOptions.border ?? 2 })
    case 'svg':
      return toSVG(qr, renderOptions)
    case 'png':
      return toPNG(qr, renderOptions)
    case 'data-url':
      return toDataURL(qr, renderOptions)
    default:
      return toSVG(qr, renderOptions)
  }
}

const isMain = Boolean(
  process.argv[1] && (
    fileURLToPath(import.meta.url).replace(/\\/g, '/').toLowerCase() === process.argv[1].replace(/\\/g, '/').toLowerCase()
    || process.argv[1].replace(/\\/g, '/').endsWith('/cli.mjs')
    || process.argv[1].replace(/\\/g, '/').endsWith('/cli.cjs')
    || process.argv[1].replace(/\\/g, '/').endsWith('/cli.ts')
    || process.argv[1].replace(/\\/g, '/').endsWith('/qrcode')
  ),
)

if (isMain) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`qrcode: ${message}`)
    console.error('Run \'qrcode --help\' for usage.')
    process.exitCode = 1
  })
}
