import assert from 'node:assert/strict'
import test from 'node:test'

import { JsonRecordReader, inspectJsonText, parseJsonRecords, pointerSegment } from '../src/json.mjs'

/**
 * The JSON readers. The interesting property is that the array is cut into
 * records by a scanner that knows what a string is -- a `]` or a `,` inside a
 * quoted value must not end anything -- and that repeated object keys are found
 * before `JSON.parse` gets a chance to resolve them silently.
 */

const texts = (result) => result.records.map((record) => record.text)

test('a top-level array is cut into records at the commas that separate them', () => {
  const result = parseJsonRecords('[{"a":1},{"a":2},{"a":3}]')
  assert.deepEqual(texts(result), ['{"a":1}', '{"a":2}', '{"a":3}'])
  assert.equal(result.error, null)
})

test('a bracket, brace or comma inside a string does not end a record', () => {
  const result = parseJsonRecords('[{"a":"},{"},{"b":"]["}]')
  assert.deepEqual(texts(result), ['{"a":"},{"}', '{"b":"]["}'])
})

test('an escaped quote inside a string does not end the string', () => {
  const result = parseJsonRecords('[{"a":"say \\"hi\\", then go"},{"b":2}]')
  assert.equal(result.records.length, 2)
  assert.equal(JSON.parse(result.records[0].text).a, 'say "hi", then go')
})

test('records are identical whether the text arrives whole or one character at a time', () => {
  const text = '[\n  {"id": 1, "note": "a, b"},\n  {"id": 2, "tags": ["x","y"]},\n  3\n]\n'
  const whole = parseJsonRecords(text)

  const reader = new JsonRecordReader({})
  const streamed = []
  for (const character of text) streamed.push(...reader.push(character))
  streamed.push(...reader.end().records)

  assert.deepEqual(
    streamed.map((record) => [record.line, record.text]),
    whole.records.map((record) => [record.line, record.text]),
  )
  assert.equal(streamed.length, 3, 'the comparison is over a file with several records in it')
})

test('an empty array yields no records and no error', () => {
  const result = parseJsonRecords('[]')
  assert.deepEqual(result.records, [])
  assert.equal(result.error, null)
})

test('the line each record starts on is reported', () => {
  const result = parseJsonRecords('[\n1,\n2,\n\n3\n]')
  assert.deepEqual(result.records.map((record) => record.line), [2, 3, 5])
})

test('a top level that is not an array is refused, not guessed at', () => {
  assert.equal(parseJsonRecords('{"a":1}').error.kind, 'not-array')
  assert.equal(parseJsonRecords('"text"').error.kind, 'not-array')
  assert.equal(parseJsonRecords('').error.kind, 'not-array')
})

test('content after the array and an array that never closes are both refused', () => {
  assert.equal(parseJsonRecords('[1] trailing').error.kind, 'trailing-content')
  assert.equal(parseJsonRecords('[1, 2').error.kind, 'unterminated-array')
})

test('NDJSON reads one record per line and skips blank lines', () => {
  const result = parseJsonRecords('{"a":1}\n{"a":2}\n\n{"a":3}', { mode: 'lines' })
  assert.deepEqual(texts(result), ['{"a":1}', '{"a":2}', '{"a":3}'])
  assert.deepEqual(result.records.map((record) => record.line), [1, 2, 4])
})

test('NDJSON tolerates CRLF line endings', () => {
  const result = parseJsonRecords('{"a":1}\r\n{"a":2}\r\n', { mode: 'lines' })
  assert.deepEqual(texts(result), ['{"a":1}', '{"a":2}'])
})

test('a record past the character bound is flagged and the reader carries on', () => {
  const result = parseJsonRecords('[{"a":"aaaaaaaaaaaaaaaaaaaa"},{"b":2}]', { maxRecordChars: 8 })
  assert.equal(result.records[0].truncated, true)
  assert.equal(result.records[1].truncated, false)
  assert.equal(result.records[1].text, '{"b":2}')
})

test('a repeated object key is found, with the pointer it sits at', () => {
  const inspected = inspectJsonText('{"a":1,"b":{"c":1,"c":2},"a":3}')
  assert.deepEqual(
    [...inspected.duplicates].sort((left, right) => (left.pointer < right.pointer ? -1 : 1)),
    [
      { key: 'a', pointer: '/a' },
      { key: 'c', pointer: '/b/c' },
    ],
  )
})

test('a repeated key inside an array element is pointed at by index', () => {
  const inspected = inspectJsonText('{"rows":[{"x":1},{"y":1,"y":2}]}')
  assert.deepEqual(inspected.duplicates, [{ key: 'y', pointer: '/rows/1/y' }])
})

test('a value that merely equals a key name is not a duplicate key', () => {
  assert.deepEqual(inspectJsonText('{"a":"a","b":"a"}').duplicates, [])
})

test('JSON.parse cannot answer the duplicate-key question, which is why the scan exists', () => {
  const text = '{"email":"first@example.test","email":"second@example.test"}'
  assert.deepEqual(Object.keys(JSON.parse(text)), ['email'])
  assert.equal(inspectJsonText(text).duplicates.length, 1)
})

test('nesting depth is counted, and a scalar record is depth one', () => {
  assert.equal(inspectJsonText('{"a":{"b":[{"c":1}]}}').depth, 4)
  assert.equal(inspectJsonText('{}').depth, 1)
  assert.equal(inspectJsonText('5').depth, 1)
})

test('pointer segments escape the characters RFC 6901 reserves', () => {
  assert.equal(pointerSegment('a/b'), 'a~1b')
  assert.equal(pointerSegment('a~b'), 'a~0b')
  assert.equal(inspectJsonText('{"a/b":{"x":1,"x":2}}').duplicates[0].pointer, '/a~1b/x')
})
