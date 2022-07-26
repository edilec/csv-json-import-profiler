import assert from 'node:assert/strict'
import test from 'node:test'

import { CsvReader, parseCsv, validateDelimiter } from '../src/csv.mjs'

/**
 * The RFC 4180 reader, exercised on the three things that break naive CSV
 * parsers: a delimiter inside quotes, a newline inside quotes, and a doubled
 * quote meaning one literal quote.
 */

const values = (result) => result.records.map((record) => record.fields.map((field) => field.value))

test('a quoted field may contain the delimiter', () => {
  const result = parseCsv('id,note\n1,"a, b, c"\n')
  assert.deepEqual(values(result), [
    ['id', 'note'],
    ['1', 'a, b, c'],
  ])
})

test('a quoted field may contain a newline, and the record survives it', () => {
  const result = parseCsv('id,note\n1,"first\nsecond"\n2,plain\n')
  assert.equal(result.records.length, 3)
  assert.deepEqual(values(result)[1], ['1', 'first\nsecond'])
  // The embedded newline advances the line counter without ending the record,
  // so the record after it is reported at the line it really sits on.
  assert.deepEqual(result.records.map((record) => record.line), [1, 2, 4])
})

test('a doubled quote inside a quoted field is one literal quote', () => {
  const result = parseCsv('id,note\n1,"say ""hi"" once"\n')
  assert.deepEqual(values(result)[1], ['1', 'say "hi" once'])
})

test('a quoted field may contain both a delimiter and a newline at once', () => {
  const result = parseCsv('a,b\n"x,\ny",z\n')
  assert.deepEqual(values(result)[1], ['x,\ny', 'z'])
})

test('CRLF, LF and a lone CR each end a record', () => {
  const result = parseCsv('a\r\nb\nc\rd')
  assert.deepEqual(values(result), [['a'], ['b'], ['c'], ['d']])
  assert.deepEqual(result.endings, { cr: 1, crlf: 1, lf: 1 })
})

test('a newline inside quotes is not counted as a line ending', () => {
  // Otherwise every multiline field would make a file look like it mixed
  // CRLF with LF, and the mixed-line-ending finding would be noise.
  const result = parseCsv('a\r\n"one\ntwo"\r\n')
  assert.deepEqual(result.endings, { cr: 0, crlf: 2, lf: 0 })
})

test('records are identical whether the text arrives whole or one character at a time', () => {
  const text = 'id,note,amount\r\n1,"a, b",10\r\n2,"line one\nline two",20\r\n3,"say ""hi""",30\n'
  const whole = parseCsv(text)

  const reader = new CsvReader({})
  const streamed = []
  for (const character of text) streamed.push(...reader.push(character))
  streamed.push(...reader.end().records)

  assert.deepEqual(
    streamed.map((record) => [record.line, record.fields.map((field) => field.value)]),
    whole.records.map((record) => [record.line, record.fields.map((field) => field.value)]),
  )
  assert.equal(streamed.length, 4, 'the comparison is over a file with several records in it')
})

test('a record that is split across chunks mid-quote still parses', () => {
  const reader = new CsvReader({})
  const first = reader.push('id,note\n1,"half')
  const second = reader.push(' and half"\n')
  assert.equal(first.length, 1)
  assert.deepEqual(
    second.map((record) => record.fields.map((field) => field.value)),
    [['1', 'half and half']],
  )
})

test('an unterminated quoted field is reported, never guessed at', () => {
  const result = parseCsv('id,note\n1,"never closed\n2,also swallowed\n')
  assert.equal(result.unterminated, true)
  assert.equal(result.unterminatedLine, 2)
  // Only the header came back. The reader does not invent a shape for the
  // record it could not finish.
  assert.deepEqual(values(result), [['id', 'note']])
})

test('a completely empty line is skipped rather than reported as a one-field record', () => {
  const result = parseCsv('a,b\n\n1,2\n\n')
  assert.deepEqual(values(result), [
    ['a', 'b'],
    ['1', '2'],
  ])
})

test('a quoted empty field and an unquoted empty field are told apart', () => {
  const result = parseCsv('a,b,c\n"",,x\n')
  assert.deepEqual(result.records[1].fields, [
    { value: '', quoted: true },
    { value: '', quoted: false },
    { value: 'x', quoted: false },
  ])
})

test('a final record without a trailing newline is emitted', () => {
  assert.deepEqual(values(parseCsv('a,b\n1,2')), [
    ['a', 'b'],
    ['1', '2'],
  ])
})

test('a trailing delimiter produces a trailing empty field', () => {
  assert.deepEqual(values(parseCsv('a,b,\n')), [['a', 'b', '']])
})

test('a quote inside an unquoted field is literal text', () => {
  assert.deepEqual(values(parseCsv('a\n12" pipe\n')), [['a'], ['12" pipe']])
})

test('an alternative delimiter is honoured and a quote is still a quote', () => {
  const result = parseCsv('a;b\n"x;y";z\n', { delimiter: ';' })
  assert.deepEqual(values(result)[1], ['x;y', 'z'])
})

test('a record past the character bound is flagged and the reader resynchronises', () => {
  const result = parseCsv('aaaaaaaaaaaa,b\nx,y\n', { maxRecordChars: 5 })
  assert.equal(result.records[0].truncated, true)
  assert.equal(result.records[0].chars, 14, 'the full size is still counted')
  assert.equal(result.records[1].truncated, false)
  assert.deepEqual(
    result.records[1].fields.map((field) => field.value),
    ['x', 'y'],
    'the record after an oversized one is read normally',
  )
})

test('a delimiter that could not be one is refused', () => {
  assert.throws(() => validateDelimiter('"'), /quote or a line ending/)
  assert.throws(() => validateDelimiter('\n'), /quote or a line ending/)
  assert.throws(() => validateDelimiter(',,'), /single character/)
  assert.throws(() => validateDelimiter(''), /single character/)
  assert.equal(validateDelimiter('\t'), '\t')
})
