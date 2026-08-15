/*
 * PromptPay (Thai QR payment) payload generator.
 *
 * Follows the EMVCo QRCPS Merchant Presented Mode specification and the
 * Bank of Thailand PromptPay QR Code standard. Structure and normalization
 * logic based on dtinth/promptpay-qr (MIT License):
 * https://github.com/dtinth/promptpay-qr
 */

import type { GenerateOptions, QRCodeData } from '../generate'
import { generate } from '../generate'

export type PromptPayType = 'mobile' | 'nationalId' | 'ewalletId'

export interface PromptPayOptions {
  /**
   * Transfer amount in Baht. When omitted, a static (no amount) QR is
   * generated. @default undefined
   */
  amount?: number
  /**
   * Maximum transfer amount allowed (Baht). Override when the applicable
   * PromptPay limit differs from `MAX_PROMPTPAY_AMOUNT`.
   * @default MAX_PROMPTPAY_AMOUNT
   */
  maxAmount?: number
}

export interface PromptPayCheckResult {
  ok: boolean
  error?: string
  /** Detected PromptPay ID type. */
  type?: PromptPayType
  /** Normalized 13-digit target as it appears in the payload. */
  target?: string
  /** The generated EMVCo payload (when `ok`). */
  payload?: string
}

const ID_PAYLOAD_FORMAT = '00'
const ID_POI_METHOD = '01'
const ID_MERCHANT_INFORMATION = '29'
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
const CURRENCY_THB = '764'
const COUNTRY_CODE_TH = 'TH'

/** Maximum transfer amount per transaction (Baht). Current BOT PromptPay limit. */
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

function crc16(data: string): number {
  let crc = 0xFFFF
  for (let i = 0; i < data.length; i++) {
    crc ^= data.charCodeAt(i) << 8
    for (let j = 0; j < 8; j++)
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1
    crc &= 0xFFFF
  }
  return crc
}

/**
 * Validate a PromptPay ID / amount and report the normalized form.
 */
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

/**
 * Generate an EMVCo PromptPay payload string for the given PromptPay ID.
 *
 * Supports mobile numbers (e.g. `0812345678`, `+66-89-123-4567`), national
 * ID / tax ID (13 digits) and e-wallet IDs (15 digits). The returned string
 * is ready to be encoded into a QR Code (see `generatePromptPay`).
 *
 * Throws `RangeError` on invalid IDs or amounts (same rules as
 * `checkPromptPay`).
 */
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

/**
 * Generate a PromptPay QR Code, ready to render.
 *
 * ```ts
 * const qr = generatePromptPay('0812345678', { amount: 100 })
 * const svg = toSVG(qr)
 * ```
 */
export function generatePromptPay(id: string, options: PromptPayOptions & GenerateOptions = {}): QRCodeData {
  const { amount, maxAmount, ...qrOptions } = options
  const payload = promptPay(id, { amount, maxAmount })
  return generate(payload, qrOptions)
}
