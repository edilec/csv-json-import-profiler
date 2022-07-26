import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FAMILIES,
  TYPES,
  classifyCsvValue,
  classifyJsonValue,
  familyOf,
  hasLeadingZeros,
  isIsoDate,
  isPadded,
  isUnsafeInteger,
  valueText,
} from '../src/values.mjs'

/**
 * Classification, which is the one place a profiler is tempted to be helpful
 * and must not be. Every assertion here is really the same assertion: the value
 * is described, never repaired.
 */

test('CSV values are classified without being coerced or trimmed', () => {
  const cases = [
    ['42', 'integer'],
    ['-42', 'integer'],
    ['+42', 'integer'],
    ['4.5', 'number'],
    ['.5', 'number'],
    ['1e6', 'number'],
    ['true', 'boolean'],
    ['FALSE', 'boolean'],
    ['2026-01-04', 'date'],
    ['2026-01-04T09:30:00Z', 'date'],
    ['forty-two', 'string'],
    ['1,234', 'string'],
    ['0x1f', 'string'],
    [' 42', 'string'],
    ['42 ', 'string'],
  ]
  for (const [value, expected] of cases) {
    assert.equal(classifyCsvValue(value), expected, `${JSON.stringify(value)} is ${expected}`)
  }
})

test('a padded number is a string, and the padding is reported separately', () => {
  // The alternative is trimming, which is a rewrite: an importer that keeps the
  // space sees a string, so a profile that trimmed would describe a file the
  // importer is not reading.
  assert.equal(classifyCsvValue(' 42'), 'string')
  assert.equal(isPadded(' 42'), true)
  assert.equal(isPadded('42'), false)
  assert.equal(isPadded(''), false)
})

test('an unquoted empty field is null and a quoted empty field is an empty string', () => {
  assert.equal(classifyCsvValue('', { quoted: false }), 'null')
  assert.equal(classifyCsvValue('', { quoted: true }), 'empty')
})

test('a configured null token counts as null however it was written', () => {
  const options = { nullTokens: ['NULL', 'N/A'] }
  assert.equal(classifyCsvValue('NULL', options), 'null')
  assert.equal(classifyCsvValue('N/A', { ...options, quoted: true }), 'null')
  assert.equal(classifyCsvValue('null', options), 'string', 'matching is exact, not case-folded')
})

test('ISO dates are validated against the calendar, not against a regular expression alone', () => {
  assert.equal(isIsoDate('2024-02-29'), true, '2024 is a leap year')
  assert.equal(isIsoDate('2026-02-29'), false, '2026 is not')
  assert.equal(isIsoDate('1900-02-29'), false, 'a century that is not a leap year')
  assert.equal(isIsoDate('2000-02-29'), true, 'a century that is')
  assert.equal(isIsoDate('2026-13-01'), false)
  assert.equal(isIsoDate('2026-04-31'), false)
  assert.equal(isIsoDate('2026-01-04T25:00:00Z'), false)
  assert.equal(isIsoDate('2026-01-04T09:30:00+05:30'), true)
  assert.equal(isIsoDate('04/01/2026'), false, 'an ambiguous local format is not a date here')
})

test('integers outside the exact range of a double are detected before they are parsed', () => {
  assert.equal(isUnsafeInteger('9007199254740993'), true)
  assert.equal(isUnsafeInteger('-9007199254740993'), true)
  assert.equal(isUnsafeInteger('9007199254740991'), false)
  assert.equal(isUnsafeInteger('42'), false)
  assert.equal(isUnsafeInteger('4.5'), false)
  // The reason the check uses BigInt: by the time a number exists the
  // information the check needs is already gone.
  assert.equal(Number('9007199254740993'), 9007199254740992)
})

test('leading zeros are detected, because typing the column as a number eats them', () => {
  assert.equal(hasLeadingZeros('007'), true)
  assert.equal(hasLeadingZeros('-007'), true)
  assert.equal(hasLeadingZeros('0'), false)
  assert.equal(hasLeadingZeros('70'), false)
})

test('JSON values are classified from their own types', () => {
  assert.equal(classifyJsonValue(null), 'null')
  assert.equal(classifyJsonValue(true), 'boolean')
  assert.equal(classifyJsonValue(7), 'integer')
  assert.equal(classifyJsonValue(7.5), 'number')
  assert.equal(classifyJsonValue(''), 'empty')
  assert.equal(classifyJsonValue('text'), 'string')
  assert.equal(classifyJsonValue('2026-01-04'), 'date')
  assert.equal(classifyJsonValue({ a: 1 }), 'structured')
  assert.equal(classifyJsonValue([1]), 'structured')
})

test('families group the types that can share a column, and null belongs to none', () => {
  assert.equal(familyOf('integer'), 'numeric')
  assert.equal(familyOf('number'), 'numeric')
  assert.equal(familyOf('string'), 'text')
  assert.equal(familyOf('empty'), 'text')
  assert.equal(familyOf('null'), null)
  assert.throws(() => familyOf('decimal'), /Unknown value type/)
})

test('every declared type maps to a declared family or to none', () => {
  for (const type of TYPES) {
    const family = familyOf(type)
    assert.equal(family === null || FAMILIES.includes(family), true, `${type} maps somewhere known`)
  }
})

test('a value is described for length and sampling without being reformatted', () => {
  assert.equal(valueText('text'), 'text')
  assert.equal(valueText(7), '7')
  assert.equal(valueText(null), 'null')
  assert.equal(valueText([1, 2]), '[array]')
  assert.equal(valueText({ a: 1 }), '{object}')
})
