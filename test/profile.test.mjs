import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { DEFAULT_LIMITS, formatReport, profileBytes, profileFile, profileText } from '../src/index.mjs'

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const ruleIds = (report) => report.findings.map((finding) => finding.ruleId)
const column = (report, name) => report.profile.columns.find((entry) => entry.name === name)

async function withDirectory(body) {
  const base = await mkdtemp(join(tmpdir(), 'csv-json-import-profiler-'))
  try {
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

/* Acceptance: the two shapes the build requirement names by hand. */

test('a quoted multiline CSV field is profiled as one record with one value', async () => {
  const csv = [
    'id,note',
    '1,"first line',
    'second line, with a comma',
    'and a ""quote"" too"',
    '2,plain',
    '',
  ].join('\n')

  const report = await profileText(csv, { file: 'notes.csv', format: 'csv' })

  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 2)
  assert.equal(report.summary.driftedRecords, 0)
  assert.deepEqual(column(report, 'note').families, ['text'])
  // The multiline value is one value: 54 characters across three physical
  // lines, not three records of unknown shape.
  assert.equal(column(report, 'note').maxLength, 54)
})

test('a column holding numbers and words is reported as mixed, and nothing is coerced', async () => {
  const csv = 'id,amount\n1,10.50\n2,unpriced\n3,7\n'
  const report = await profileText(csv, { file: 'orders.csv', format: 'csv' })

  assert.equal(report.status, 'fail')
  assert.deepEqual(ruleIds(report), ['column-type-mixed'])

  const amount = column(report, 'amount')
  assert.deepEqual(amount.families, ['numeric', 'text'])
  // Both types survive in the profile with their own counts. A profiler that
  // picked the popular one would report a file nobody has.
  assert.deepEqual(amount.types, { integer: 1, number: 1, string: 1 })
  assert.deepEqual(
    amount.samples.map((sample) => [sample.record, sample.family]),
    [[1, 'numeric'], [2, 'text']],
    'each family is referenced by the record it first appeared in',
  )
})

test('a numeric column is not mixed just because it holds both integers and decimals', async () => {
  const report = await profileText('id,amount\n1,10\n2,10.5\n', { file: 'orders.csv', format: 'csv' })
  assert.equal(report.status, 'pass')
  assert.deepEqual(column(report, 'amount').families, ['numeric'])
})

test('a quoted empty field in a numeric column is the mixed-type hazard, and is reported', async () => {
  const report = await profileText('id,amount\n1,10\n2,""\n', { file: 'orders.csv', format: 'csv' })
  assert.deepEqual(ruleIds(report), ['column-type-mixed'])
  assert.equal(column(report, 'amount').empty, 1)
  assert.equal(column(report, 'amount').nulls, 0, 'an empty string is not a null')
})

/* Row shape drift, duplicate keys, nulls. */

test('a row whose field count differs from the header is reported and not attributed to columns', async () => {
  const csv = 'id,name,amount\n1,Ann,10\n2,Bob,20,stray\n3,Cid,30\n'
  const report = await profileText(csv, { file: 'orders.csv', format: 'csv' })

  assert.equal(report.status, 'fail')
  assert.deepEqual(ruleIds(report), ['row-field-count-drift'])
  const finding = report.findings[0]
  assert.equal(finding.record, 2)
  assert.equal(finding.line, 3)
  assert.equal(report.summary.driftedRecords, 1)
  assert.equal(report.summary.checked, 3, 'the drifted row was examined')
  assert.equal(report.summary.profiled, 2, 'but its values were not attributed to columns')
  assert.equal(column(report, 'amount').types.integer, 2)
})

test('a duplicate header name is reported against the column it collides with', async () => {
  const report = await profileText('id,ref,ref\n1,a,b\n', { file: 'orders.csv', format: 'csv' })
  assert.deepEqual(ruleIds(report), ['duplicate-header-key'])
  assert.equal(report.findings[0].location.pointer, '/columns/ref')
  assert.equal(report.status, 'fail')
})

test('an unnamed header column is reported by index', async () => {
  const report = await profileText('id,,amount\n1,x,2\n', { file: 'orders.csv', format: 'csv' })
  assert.deepEqual(ruleIds(report), ['header-column-unnamed'])
  assert.equal(report.findings[0].location.pointer, '/columns/#1')
  assert.equal(report.status, 'pass', 'an unnamed column is a warning, not a refusal')
})

test('a repeated JSON object key is reported, with the pointer inside the record', async () => {
  const report = await profileText('[{"sku":"A","sku":"B"}]', { file: 'catalog.json', format: 'json' })
  assert.deepEqual(ruleIds(report), ['duplicate-object-key'])
  assert.equal(report.findings[0].location.pointer, '/records/1/sku')
  assert.equal(report.summary.duplicateKeys, 1)
  assert.equal(report.status, 'fail')
})

test('a record whose key set differs from the first is reported as drift', async () => {
  const json = '[{"a":1,"b":2},{"a":3},{"a":4,"b":5,"c":6}]'
  // nullRatio 1 isolates the drift rule: a key present in one record of three
  // is also a mostly-absent column, and that is a separate finding.
  const report = await profileText(json, { file: 'records.json', format: 'json', nullRatio: 1 })
  assert.deepEqual(ruleIds(report), ['record-key-drift', 'record-key-drift'])
  assert.match(report.findings[0].message, /missing 1: b/)
  assert.match(report.findings[1].message, /extra 1: c/)
  assert.equal(report.status, 'pass', 'key drift is a warning: optional fields are legitimate')
})

test('a record that is not an object carries no fields to import, and is refused', async () => {
  const report = await profileText('[{"a":1},7]', { file: 'records.json', format: 'json' })
  assert.deepEqual(ruleIds(report), ['record-not-an-object'])
  assert.equal(report.status, 'fail')
})

test('nulls are counted per column, and an entirely empty column is named', async () => {
  const csv = 'id,note\n1,\n2,\n3,\n'
  const report = await profileText(csv, { file: 'orders.csv', format: 'csv' })
  assert.deepEqual(ruleIds(report), ['column-all-null'])
  assert.equal(column(report, 'note').nulls, 3)
  assert.equal(report.summary.nulls, 3)
})

test('the null ratio is a documented threshold, and moving it changes the verdict', async () => {
  const csv = 'id,note\n1,a\n2,\n3,\n'
  const loud = await profileText(csv, { file: 'orders.csv', format: 'csv', nullRatio: 0.5 })
  const quiet = await profileText(csv, { file: 'orders.csv', format: 'csv', nullRatio: 0.9 })
  assert.deepEqual(ruleIds(loud), ['column-null-ratio-high'])
  assert.deepEqual(ruleIds(quiet), [])
})

test('a JSON key missing from a record counts against that column as absent', async () => {
  const report = await profileText('[{"a":1,"b":2},{"a":3},{"a":4}]', { file: 'records.json', format: 'json' })
  assert.equal(column(report, 'b').seen, 1)
  assert.equal(column(report, 'b').absent, 2)
  assert.equal(ruleIds(report).includes('column-null-ratio-high'), true)
})

test('integers that a number type would damage are reported', async () => {
  const csv = 'id,zip,big\n1,007,9007199254740993\n'
  const report = await profileText(csv, { file: 'orders.csv', format: 'csv' })
  assert.deepEqual(ruleIds(report).sort(), ['column-integer-leading-zeros', 'column-integer-unsafe'])
  assert.equal(report.status, 'pass', 'both are warnings: the file is readable, the import would not be')
})

/* Encoding and framing. */

test('a byte order mark is reported rather than silently absorbed', async () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('id,name\n1,Ann\n')])
  const report = await profileBytes(bytes, { file: 'orders.csv', format: 'csv' })
  assert.deepEqual(ruleIds(report), ['input-has-bom'])
  assert.deepEqual(
    report.profile.columns.map((entry) => entry.name),
    ['id', 'name'],
    'the mark is stripped from the first column name by the decoder',
  )
})

test('mixed line endings are reported', async () => {
  const report = await profileText('id,name\r\n1,Ann\n2,Bob\n', { file: 'orders.csv', format: 'csv' })
  assert.deepEqual(ruleIds(report), ['input-mixed-line-endings'])
  assert.equal(report.status, 'pass')
})

test('bytes that are not UTF-8 are refused by the decoder, and the run is incomplete', async () => {
  const bytes = new Uint8Array([0x69, 0x64, 0x0a, 0x31, 0xff, 0x0a])
  const report = await profileBytes(bytes, { file: 'orders.csv', format: 'csv' })
  assert.equal(report.status, 'incomplete')
  assert.equal(ruleIds(report).includes('input-not-utf8'), true)
})

test('a decoding failure part-way through a file is incomplete even though earlier records profiled', async () => {
  // The file is deliberately larger than one read: the first chunk decodes and
  // its records are profiled, and the second chunk carries the invalid byte. A
  // run with real evidence in it is still incomplete, because part of the input
  // was never read -- so the incomplete flag on the decoding failure is what
  // decides the status here, not the empty-run guard.
  await withDirectory(async (base) => {
    const target = join(base, 'wide.csv')
    const rows = Buffer.from(`id,note\n${`1,${'x'.repeat(30)}\n`.repeat(3000)}`)
    await writeFile(target, Buffer.concat([rows, Buffer.from([0xff, 0x0a])]))

    const report = await profileFile({ input: target })
    assert.equal(rows.length > 65536, true, 'the valid part spans more than one read')
    assert.equal(report.summary.checked > 0, true, 'records before the bad byte were profiled')
    assert.equal(report.status, 'incomplete')
    assert.equal(ruleIds(report).includes('input-not-utf8'), true)
  })
})

test('a file that stops in the middle of a character is refused at the flush', async () => {
  // The lead byte of a two-byte sequence with nothing after it. A streaming
  // decoder cannot complain until the end of the stream, which is exactly why
  // the final flush is not optional: without it the file would look complete
  // and one truncated character would vanish.
  const bytes = new Uint8Array([...new TextEncoder().encode('id\n1\n'), 0xc3])
  const report = await profileBytes(bytes, { file: 'input.csv', format: 'csv' })

  assert.equal(report.summary.checked, 1, 'the records before the truncation were profiled')
  assert.equal(report.status, 'incomplete')
  assert.equal(ruleIds(report).includes('input-not-utf8'), true)
})

test('a literal replacement character in a valid file is not mistaken for a decoding failure', async () => {
  // The defect this guards: inferring "not UTF-8" from U+FFFD in decoded text
  // cannot tell a broken file from a file that legitimately contains that
  // character, and the confusion turns an unreadable input into a pass.
  const report = await profileText(`id,name\n1,${String.fromCharCode(0xfffd)}\n`, {
    file: 'orders.csv',
    format: 'csv',
  })
  assert.equal(report.status, 'pass')
  assert.equal(ruleIds(report).includes('input-not-utf8'), false)
})

test('a JSON file whose top level is not an array is refused with an incomplete report', async () => {
  const report = await profileText('{"rows":[{"a":1}]}', { file: 'records.json', format: 'json' })
  assert.equal(report.status, 'incomplete')
  assert.equal(ruleIds(report).includes('input-not-an-array'), true)
})

/* The envelope, the vacuous pass, and configuration. */

test('a run that profiled no record is incomplete and says so', async () => {
  const report = await profileText('id,name\n', { file: 'orders.csv', format: 'csv' })
  assert.equal(report.summary.checked, 0)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(ruleIds(report), ['no-records-profiled'])
  // The guarantee in one line: pass with checked 0 is not reachable.
  assert.notEqual(report.status, 'pass')
})

test('the report carries the documented envelope', async () => {
  const report = await profileText('id\n1\n', { file: 'orders.csv', format: 'csv' })
  assert.equal(report.schemaVersion, '1')
  assert.equal(report.tool, 'csv-json-import-profiler')
  assert.deepEqual(Object.keys(report), ['schemaVersion', 'tool', 'status', 'summary', 'profile', 'findings'])
  assert.equal(typeof report.summary.checked, 'number')
  assert.equal(Array.isArray(report.findings), true)
})

test('an unknown option, limit or format is refused rather than ignored', async () => {
  await assert.rejects(() => profileText('a\n1\n', { file: 'a.csv', formats: 'csv' }), /Unknown option "formats"/)
  await assert.rejects(
    () => profileText('a\n1\n', { file: 'a.csv', format: 'csv', limits: { maxRecord: 5 } }),
    /Unknown limit "maxRecord"/,
  )
  await assert.rejects(() => profileText('a\n1\n', { file: 'a.csv', format: 'tsv' }), /Unknown format "tsv"/)
  await assert.rejects(() => profileText('a\n1\n', { file: 'a.csv', format: 'csv', limits: null }), /must be an object/)
  await assert.rejects(
    () => profileText('a\n1\n', { file: 'a.csv', format: 'csv', limits: { maxRecords: 0 } }),
    /at least 1/,
  )
  await assert.rejects(() => profileText('a\n1\n', { file: 'a.csv', format: 'csv', nullRatio: 2 }), /between 0 and 1/)
  await assert.rejects(
    () => profileText('a\n1\n', { file: 'a.csv', format: 'csv', nullTokens: ['a\nb'] }),
    /control characters/,
  )
})

test('a format that cannot be inferred is a configuration error, never a guess', async () => {
  await assert.rejects(() => profileText('a\n1\n', { file: 'export' }), /Cannot infer a format/)
  const inferred = await profileText('a\n1\n', { file: 'export.csv' })
  assert.equal(inferred.profile.format, 'csv')
})

test('the default limits are the documented ones', () => {
  assert.deepEqual(DEFAULT_LIMITS, {
    maxColumns: 256,
    maxDepth: 16,
    maxFindings: 1000,
    maxInputBytes: 8388608,
    maxMillis: 10000,
    maxRecords: 10000,
    maxRowBytes: 65536,
  })
})

/* The file path. */

test('a file is reported by a path relative to the root, never by an absolute one', async () => {
  const report = await profileFile({
    input: join(projectDirectory, 'examples/orders-clean.csv'),
    root: projectDirectory,
  })
  assert.equal(report.profile.file, 'examples/orders-clean.csv')
  assert.equal(report.status, 'pass')
  assert.equal(JSON.stringify(report).includes(projectDirectory), false, 'no host path reaches the report')
})

test('an input that does not exist produces an incomplete report, not a throw', async () => {
  const report = await profileFile({ input: join(projectDirectory, 'examples/missing.csv') })
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(ruleIds(report), ['input-unreadable', 'no-records-profiled'])
  assert.equal(report.profile.file, 'missing.csv')
})

test('a directory given as the input is reported as unreadable', async () => {
  const report = await profileFile({ input: join(projectDirectory, 'examples'), format: 'csv' })
  assert.equal(report.status, 'incomplete')
  assert.equal(ruleIds(report).includes('input-unreadable'), true)
})

test('the human summary carries the status, the columns and the findings', async () => {
  const report = await profileText('id,amount\n1,10\n2,two\n', { file: 'orders.csv', format: 'csv' })
  const text = formatReport(report)
  assert.match(text, /status fail/)
  assert.match(text, /column-type-mixed/)
  assert.match(text, /masked shapes/)
  assert.equal(text.endsWith('\n'), true)
})

test('two inputs in different formats produce the same envelope', async () => {
  await withDirectory(async (base) => {
    await writeFile(join(base, 'a.csv'), 'id,name\n1,Ann\n')
    await writeFile(join(base, 'b.jsonl'), '{"id":1,"name":"Ann"}\n')
    const csv = await profileFile({ input: join(base, 'a.csv') })
    const jsonl = await profileFile({ input: join(base, 'b.jsonl') })
    assert.equal(csv.profile.format, 'csv')
    assert.equal(jsonl.profile.format, 'jsonl')
    assert.deepEqual(Object.keys(csv.summary), Object.keys(jsonl.summary))
    assert.equal(csv.summary.checked, jsonl.summary.checked)
  })
})
