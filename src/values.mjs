/**
 * csv-json-import-profiler -- what a value is, decided without changing it.
 *
 * Classification never rewrites, trims, coerces or parses a value into another
 * type. That is the whole point of profiling an import: a column that holds
 * `42` in a million rows and `unknown` in one is a column that will break on
 * load, and a profiler that quietly coerced the odd one out would report the
 * health of a file nobody has.
 *
 * `" 42"` is therefore a string, not an integer. The padding is reported
 * separately -- as `column-value-padded` -- so the reason the column reads as
 * mixed is visible rather than mysterious.
 */

/** Every type this profiler can observe, in report order. */
export const TYPES = Object.freeze([
  'boolean',
  'date',
  'empty',
  'integer',
  'null',
  'number',
  'string',
  'structured',
])

/**
 * Families group the types that can share a column without breaking a load.
 *
 * `integer` and `number` are one family: a column of `1` and `1.5` is numeric
 * and imports fine. `empty` sits with `string`, because a quoted empty field in
 * a numeric column is precisely the hazard this tool exists to name -- an
 * importer that asked for a number receives `""` and stops.
 */
const FAMILY_BY_TYPE = Object.freeze({
  boolean: 'boolean',
  date: 'date',
  empty: 'text',
  integer: 'numeric',
  null: null,
  number: 'numeric',
  string: 'text',
  structured: 'structured',
})

export const FAMILIES = Object.freeze(['boolean', 'date', 'numeric', 'structured', 'text'])

/** The family a type belongs to, or `null` for the absence of a value. */
export function familyOf(type) {
  if (!Object.hasOwn(FAMILY_BY_TYPE, type)) throw new TypeError(`Unknown value type "${type}"`)
  return FAMILY_BY_TYPE[type]
}

const BOOLEAN_TOKENS = new Set(['FALSE', 'False', 'TRUE', 'True', 'false', 'true'])

const INTEGER_PATTERN = /^[+-]?\d+$/
const DECIMAL_PATTERN = /^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/
const ISO_DATE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?)?$/

const DAYS_IN_MONTH = Object.freeze([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31])

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/**
 * An ISO-8601 calendar date or date-time, validated arithmetically.
 *
 * `new Date('2026-02-30')` rolls over to 2 March in some engines and returns
 * `Invalid Date` in others, and either way it drags a clock and a time zone
 * into a pure function. The calendar is four lines of arithmetic; it is
 * cheaper than the ambiguity.
 */
export function isIsoDate(text) {
  const match = ISO_DATE_PATTERN.exec(text)
  if (match === null) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1) return false
  const limit = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1]
  if (day > limit) return false
  if (match[4] === undefined) return true
  return Number(match[4]) <= 23 && Number(match[5]) <= 59 && (match[6] === undefined || Number(match[6]) <= 60)
}

/** Digits that an importer typing the column as an integer would silently lose. */
export function hasLeadingZeros(text) {
  return /^[+-]?0\d/.test(text)
}

/**
 * An integer literal outside the range a JavaScript number represents exactly.
 *
 * Compared with `BigInt`, not by parsing to a number first: parsing is the loss
 * this is trying to detect, and `Number('9007199254740993')` has already
 * rounded by the time you could look at it.
 */
export function isUnsafeInteger(text) {
  if (!INTEGER_PATTERN.test(text)) return false
  const value = BigInt(text)
  return value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)
}

/** Whether a value carries leading or trailing whitespace an importer may keep. */
export function isPadded(text) {
  return text.length > 0 && text !== text.trim()
}

/**
 * Classify one CSV field.
 *
 * Quoting is load-bearing. An unquoted empty field is an absent value in every
 * importer worth the name; a quoted empty field is a zero-length string that
 * someone wrote down on purpose. Conflating them is how a column reports "no
 * nulls" while the load fails on a `NOT NULL` constraint, so they are counted
 * apart.
 *
 * A configured null token matches regardless of quoting, because a file that
 * writes `NULL` means it whether or not the writer quoted it.
 */
export function classifyCsvValue(value, options = {}) {
  const quoted = options.quoted === true
  const nullTokens = options.nullTokens ?? []
  if (nullTokens.includes(value)) return 'null'
  if (value === '') return quoted ? 'empty' : 'null'
  if (BOOLEAN_TOKENS.has(value)) return 'boolean'
  if (INTEGER_PATTERN.test(value)) return 'integer'
  if (DECIMAL_PATTERN.test(value)) return 'number'
  if (isIsoDate(value)) return 'date'
  return 'string'
}

/** Classify one JSON value. Objects and arrays are `structured`, not descended into. */
export function classifyJsonValue(value) {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  if (typeof value === 'string') {
    if (value === '') return 'empty'
    return isIsoDate(value) ? 'date' : 'string'
  }
  return 'structured'
}

/** The text a value contributes to length statistics and to a masked sample. */
export function valueText(value) {
  if (typeof value === 'string') return value
  if (value === null) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return Array.isArray(value) ? '[array]' : '{object}'
}
