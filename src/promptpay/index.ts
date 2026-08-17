import type { GenerateOptions, QRCodeData } from '../generate'
import { generate } from '../generate'

export type PromptPayType = 'mobile' | 'nationalId' | 'ewalletId'

export interface PromptPayOptions {
  amount?: number
  maxAmount?: number
}

export interface BillPaymentOptions {
  billerId: string
  ref1: string
  ref2?: string
  amount?: number
}

export interface PromptPayCheckResult {
  ok: boolean
  error?: string
  type?: PromptPayType
  target?: string
  payload?: string
}

export interface ParsedPromptPay {
  ok: boolean
  crcValid: boolean
  error?: string
  type?: PromptPayType | 'billPayment' | 'unknown'
  target?: string
  formattedTarget?: string
  amount?: number
  poiMethod?: 'static' | 'dynamic'
  currency?: string
  countryCode?: string
  billerId?: string
  ref1?: string
  ref2?: string
}

const ID_PAYLOAD_FORMAT = '00'
const ID_POI_METHOD = '01'
const ID_MERCHANT_INFORMATION = '29'
const ID_BILL_PAYMENT = '30'
const ID_TRANSACTION_CURRENCY = '53'
const ID_TRANSACTION_AMOUNT = '54'
const ID_COUNTRY_CODE = '58'
const ID_CRC = '63'

const PAYLOAD_FORMAT_EMV_MERCHANT_PRESENTED = '01'
const POI_METHOD_STATIC = '11'
const POI_METHOD_DYNAMIC = '12'
const TEMPLATE_ID_GUID = '00'
const BOT_ID_PHONE = '01'
const BOT_ID_TAX = '02'
const BOT_ID_EWALLET = '03'
const GUID_PROMPTPAY = 'A000000677010111'
const GUID_BILL_PAYMENT = 'A000000677010112'
const CURRENCY_THB = '764'
const COUNTRY_CODE_TH = 'TH'

export const MAX_PROMPTPAY_AMOUNT = 200000

function f(id: string, value: string): string {
  return `${id}${String(value.length).padStart(2, '0')}${value}`
}

function sanitize(id: string): string {
  return id.replace(/[^0-9]/g, '')
}

function detectType(digits: string): PromptPayType {
  if (digits.length >= 15)
    return 'ewalletId'
  if (digits.length >= 13)
    return 'nationalId'
  return 'mobile'
}

function validateTarget(id: string): string {
  const digits = sanitize(id)
  if (!digits)
    throw new RangeError('PromptPay ID is empty')
  const type = detectType(digits)
  if (type === 'mobile' && !(/^0\d{9}$/.test(digits) || /^66\d{9}$/.test(digits)))
    throw new RangeError(`Invalid mobile number: ${id}`)
  if (type === 'nationalId' && digits.length !== 13)
    throw new RangeError(`Invalid national ID / tax ID: ${id}`)
  if (type === 'ewalletId' && digits.length !== 15)
    throw new RangeError(`Invalid e-wallet ID: ${id}`)
  return digits
}

function validateAmount(amount: number, maxAmount: number): number {
  if (!Number.isFinite(amount) || amount <= 0)
    throw new RangeError(`Invalid amount: ${amount}`)
  if (amount > maxAmount)
    throw new RangeError(`Amount exceeds ${maxAmount} Baht limit`)
  const cents = Math.round(amount * 100)
  if (Math.abs(cents / 100 - amount) > 1e-6)
    throw new RangeError(`Amount can have at most 2 decimal places: ${amount}`)
  return cents / 100
}

function formatTarget(id: string): string {
  const digits = sanitize(id)
  if (digits.length >= 13)
    return digits
  return `0000000000000${digits.replace(/^0/, '66')}`.slice(-13)
}

function formatAmount(amount: number): string {
  return amount.toFixed(2)
}

export function crc16(data: string): number {
  let crc = 0xFFFF
  for (let i = 0; i < data.length; i++) {
    crc ^= data.charCodeAt(i) << 8
    for (let j = 0; j < 8; j++)
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1
    crc &= 0xFFFF
  }
  return crc
}

export function checkPromptPay(id: string, options: PromptPayOptions = {}): PromptPayCheckResult {
  let digits: string
  let type: PromptPayType
  try {
    digits = validateTarget(id)
    type = detectType(digits)
  }
  catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }

  const { amount, maxAmount = MAX_PROMPTPAY_AMOUNT } = options
  if (amount !== undefined) {
    try {
      validateAmount(amount, maxAmount)
    }
    catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  const payload = promptPay(id, options)
  return {
    ok: true,
    type,
    target: formatTarget(id),
    payload,
  }
}

export function promptPay(id: string, options: PromptPayOptions = {}): string {
  const { amount, maxAmount = MAX_PROMPTPAY_AMOUNT } = options
  const digits = validateTarget(id)
  const target = formatTarget(id)
  const type = detectType(digits)
  const typeId = type === 'ewalletId' ? BOT_ID_EWALLET : type === 'nationalId' ? BOT_ID_TAX : BOT_ID_PHONE
  const validatedAmount = amount !== undefined ? validateAmount(amount, maxAmount) : undefined

  const data = [
    f(ID_PAYLOAD_FORMAT, PAYLOAD_FORMAT_EMV_MERCHANT_PRESENTED),
    f(ID_POI_METHOD, validatedAmount !== undefined ? POI_METHOD_DYNAMIC : POI_METHOD_STATIC),
    f(ID_MERCHANT_INFORMATION, [
      f(TEMPLATE_ID_GUID, GUID_PROMPTPAY),
      f(typeId, target),
    ].join('')),
    f(ID_COUNTRY_CODE, COUNTRY_CODE_TH),
    f(ID_TRANSACTION_CURRENCY, CURRENCY_THB),
    validatedAmount !== undefined ? f(ID_TRANSACTION_AMOUNT, formatAmount(validatedAmount)) : '',
  ].join('')

  const dataToCrc = `${data}${ID_CRC}04`
  const crc = crc16(dataToCrc).toString(16).toUpperCase().padStart(4, '0')
  return `${data}${f(ID_CRC, crc)}`
}

export function billPayment(options: BillPaymentOptions): string {
  const { billerId, ref1, ref2, amount } = options
  const sanitizedBiller = sanitize(billerId)
  if (sanitizedBiller.length < 13 || sanitizedBiller.length > 15)
    throw new RangeError(`Invalid Biller ID: ${billerId} (must be 13 to 15 digits)`)
  if (!ref1 || ref1.length > 20)
    throw new RangeError('Invalid Reference 1 (must be 1-20 alphanumeric characters)')
  if (ref2 && ref2.length > 20)
    throw new RangeError('Invalid Reference 2 (must be at most 20 alphanumeric characters)')

  const validatedAmount = amount !== undefined ? validateAmount(amount, 5000000) : undefined

  const merchantInfo = [
    f(TEMPLATE_ID_GUID, GUID_BILL_PAYMENT),
    f('01', sanitizedBiller),
    f('02', ref1),
    ref2 ? f('03', ref2) : '',
  ].join('')

  const data = [
    f(ID_PAYLOAD_FORMAT, PAYLOAD_FORMAT_EMV_MERCHANT_PRESENTED),
    f(ID_POI_METHOD, validatedAmount !== undefined ? POI_METHOD_DYNAMIC : POI_METHOD_STATIC),
    f(ID_BILL_PAYMENT, merchantInfo),
    f(ID_COUNTRY_CODE, COUNTRY_CODE_TH),
    f(ID_TRANSACTION_CURRENCY, CURRENCY_THB),
    validatedAmount !== undefined ? f(ID_TRANSACTION_AMOUNT, formatAmount(validatedAmount)) : '',
  ].join('')

  const dataToCrc = `${data}${ID_CRC}04`
  const crc = crc16(dataToCrc).toString(16).toUpperCase().padStart(4, '0')
  return `${data}${f(ID_CRC, crc)}`
}

export function parseTLV(payload: string): Record<string, string> {
  const result: Record<string, string> = {}
  let pos = 0
  while (pos + 4 <= payload.length) {
    const id = payload.slice(pos, pos + 2)
    const len = Number.parseInt(payload.slice(pos + 2, pos + 4), 10)
    if (Number.isNaN(len) || pos + 4 + len > payload.length)
      break
    const val = payload.slice(pos + 4, pos + 4 + len)
    result[id] = val
    pos += 4 + len
  }
  return result
}

export function parsePromptPay(payload: string): ParsedPromptPay {
  if (typeof payload !== 'string' || payload.length < 10)
    return { ok: false, crcValid: false, error: 'Payload too short' }

  const tags = parseTLV(payload)
  if (!tags[ID_PAYLOAD_FORMAT] || !tags[ID_CRC])
    return { ok: false, crcValid: false, error: 'Invalid EMVCo format' }

  const providedCrc = tags[ID_CRC].toUpperCase()
  const dataToCrc = payload.slice(0, payload.length - 4)
  const computedCrc = crc16(dataToCrc).toString(16).toUpperCase().padStart(4, '0')
  const crcValid = providedCrc === computedCrc

  const poiMethod = tags[ID_POI_METHOD] === POI_METHOD_DYNAMIC ? 'dynamic' : 'static'
  const amount = tags[ID_TRANSACTION_AMOUNT] ? Number.parseFloat(tags[ID_TRANSACTION_AMOUNT]) : undefined
  const currency = tags[ID_TRANSACTION_CURRENCY]
  const countryCode = tags[ID_COUNTRY_CODE]

  if (tags[ID_MERCHANT_INFORMATION]) {
    const sub = parseTLV(tags[ID_MERCHANT_INFORMATION])
    if (sub[BOT_ID_PHONE]) {
      const raw = sub[BOT_ID_PHONE]
      let phone = raw
      if (phone.startsWith('0066'))
        phone = `0${phone.slice(4)}`
      return {
        ok: true,
        crcValid,
        type: 'mobile',
        target: raw,
        formattedTarget: phone,
        amount,
        poiMethod,
        currency,
        countryCode,
      }
    }
    if (sub[BOT_ID_TAX]) {
      return {
        ok: true,
        crcValid,
        type: 'nationalId',
        target: sub[BOT_ID_TAX],
        formattedTarget: sub[BOT_ID_TAX],
        amount,
        poiMethod,
        currency,
        countryCode,
      }
    }
    if (sub[BOT_ID_EWALLET]) {
      return {
        ok: true,
        crcValid,
        type: 'ewalletId',
        target: sub[BOT_ID_EWALLET],
        formattedTarget: sub[BOT_ID_EWALLET],
        amount,
        poiMethod,
        currency,
        countryCode,
      }
    }
  }

  if (tags[ID_BILL_PAYMENT] || tags['31']) {
    const sub = parseTLV(tags[ID_BILL_PAYMENT] || tags['31'])
    return {
      ok: true,
      crcValid,
      type: 'billPayment',
      billerId: sub['01'],
      ref1: sub['02'],
      ref2: sub['03'],
      amount,
      poiMethod,
      currency,
      countryCode,
    }
  }

  return {
    ok: true,
    crcValid,
    type: 'unknown',
    amount,
    poiMethod,
    currency,
    countryCode,
  }
}

export const decodePromptPay = parsePromptPay

export function generatePromptPay(id: string, options: PromptPayOptions & GenerateOptions = {}): QRCodeData {
  const { amount, maxAmount, ...qrOptions } = options
  const payload = promptPay(id, { amount, maxAmount })
  return generate(payload, qrOptions)
}

export function generateBillPayment(options: BillPaymentOptions & GenerateOptions): QRCodeData {
  const { billerId, ref1, ref2, amount, ...qrOptions } = options
  const payload = billPayment({ billerId, ref1, ref2, amount })
  return generate(payload, qrOptions)
}
