import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import test from 'node:test'

import { profileText } from '../src/index.mjs'

/**
 * Every declared limit, enforced where it is documented.
 *
 * Each test asserts `status === 'incomplete'` as well as the finding. That is
 * deliberate: the finding alone would still be there if the `incomplete` flag
 * were deleted, and for the rules whose severity is `error` the run would then
 * report `fail` -- a verdict about the input rather than an admission that part
 * of it was never read. The status assertion is what fails when the flag goes.
 *
 * Each limit is also tested from just inside it, so a bound cannot pass by
 * refusing everything.
 */

const ruleIds = (report) => report.findings.map((finding) => finding.ruleId)
const csv = (options) => ({ file: 'input.csv', format: 'csv', ...options })

test('maxInputBytes stops the read and names itself', async () => {
  const text = `id,name\n${'1,Ann\n'.repeat(50)}`
  const report = await profileText(text, csv({ limits: { maxInputBytes: 40 } }))

  assert.equal(report.status, 'incomplete')
  assert.equal(ruleIds(report).includes('input-too-large'), true)
  assert.match(report.findings.find((finding) => finding.ruleId === 'input-too-large').message, /maxInputBytes limit of 40/)
})

test('an input of exactly maxInputBytes is profiled; one byte more is refused', async () => {
  // Fourteen bytes, counted rather than assumed, so both halves of this test
  // sit on the bound itself: at 14 the input is read to the end, at 13 it is
  // not. A comparison that refused the exact limit, or let one byte past it
  // through, changes one of these two answers.
  const text = 'id,name\n1,Ann\n'
  assert.equal(Buffer.byteLength(text, 'utf8'), 14, 'the fixture is exactly as long as the limit under test')

  const exact = await profileText(text, csv({ limits: { maxInputBytes: 14 } }))
  assert.equal(exact.status, 'pass')
  assert.deepEqual(ruleIds(exact), [])
  assert.equal(exact.summary.bytes, 14)

  const over = await profileText(text, csv({ limits: { maxInputBytes: 13 } }))
  assert.equal(over.status, 'incomplete')
  assert.equal(ruleIds(over).includes('input-too-large'), true)
})

test('maxRecords stops at the record it names, and the count is exact', async () => {
  const text = `id\n${['1', '2', '3', '4', '5'].join('\n')}\n`
  const report = await profileText(text, csv({ limits: { maxRecords: 3 } }))

  assert.equal(report.status, 'incomplete')
  assert.equal(ruleIds(report).includes('too-many-records'), true)
  assert.equal(report.summary.checked, 3, 'exactly the allowed number of records was profiled')
})

test('a file of exactly maxRecords records is complete', async () => {
  const report = await profileText('id\n1\n2\n3\n', csv({ limits: { maxRecords: 3 } }))
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 3)
})

test('maxRowBytes refuses the oversized row by number and keeps going', async () => {
  const text = `id,note\n1,${'x'.repeat(100)}\n2,short\n`
  const report = await profileText(text, csv({ limits: { maxRowBytes: 40 } }))

  assert.equal(report.status, 'incomplete')
  const finding = report.findings.find((entry) => entry.ruleId === 'row-too-large')
  assert.notEqual(finding, undefined)
  assert.equal(finding.record, 1)
  assert.match(finding.message, /maxRowBytes limit of 40/)
  assert.equal(report.summary.skipped, 1)
  assert.equal(report.summary.checked, 1, 'the record after the oversized one was still profiled')
})

test('maxRowBytes counts bytes, not characters, when the two differ', async () => {
  // Ten accented characters are ten characters and twenty bytes. A limit of
  // fifteen must refuse them: an importer reads bytes.
  const text = `id,note\n1,${'é'.replace('é', 'é').repeat(10)}\n`
  const report = await profileText(text, csv({ limits: { maxRowBytes: 15 } }))

  assert.equal(report.status, 'incomplete')
  const finding = report.findings.find((entry) => entry.ruleId === 'row-too-large')
  assert.match(finding.message, /is 22 bytes/)
})

test('a record of exactly maxRowBytes is profiled; one byte more is refused', async () => {
  // Three accented characters make the record five characters and eight bytes,
  // so the byte comparison is the one on trial here rather than the reader's
  // character bound: at a limit of 8 the record is profiled, at 7 it is not.
  const text = 'id,note\n1,\u00e9\u00e9\u00e9\n'
  assert.equal(Buffer.byteLength('1,\u00e9\u00e9\u00e9', 'utf8'), 8, 'the record is exactly as long as the limit under test')

  const exact = await profileText(text, csv({ limits: { maxRowBytes: 8 } }))
  assert.equal(exact.status, 'pass')
  assert.deepEqual(ruleIds(exact), [])
  assert.equal(exact.summary.checked, 1)

  const over = await profileText(text, csv({ limits: { maxRowBytes: 7 } }))
  assert.equal(over.status, 'incomplete')
  assert.equal(over.summary.skipped, 1)
  const finding = over.findings.find((entry) => entry.ruleId === 'row-too-large')
  assert.notEqual(finding, undefined)
  assert.match(finding.message, /is 8 bytes/)
})

test('maxColumns refuses a header wider than the limit', async () => {
  const header = Array.from({ length: 6 }, (_, index) => `c${index}`).join(',')
  const report = await profileText(`${header}\n1,2,3,4,5,6\n`, csv({ limits: { maxColumns: 4 } }))

  assert.equal(report.status, 'incomplete')
  assert.equal(ruleIds(report).includes('too-many-columns'), true)
  assert.equal(report.summary.checked, 0, 'nothing was profiled against a header that was refused')
})

test('a header of exactly maxColumns is profiled; one column more is refused', async () => {
  const exact = await profileText('a,b,c,d\n1,2,3,4\n', csv({ limits: { maxColumns: 4 } }))
  assert.equal(exact.status, 'pass')
  assert.deepEqual(ruleIds(exact), [])
  assert.equal(exact.summary.columns, 4)
  assert.equal(exact.summary.checked, 1)

  const over = await profileText('a,b,c,d,e\n1,2,3,4,5\n', csv({ limits: { maxColumns: 4 } }))
  assert.equal(over.status, 'incomplete')
  assert.equal(ruleIds(over).includes('too-many-columns'), true)
})

test('maxColumns also counts JSON keys as they appear', async () => {
  const report = await profileText('[{"a":1,"b":2},{"c":3,"d":4}]', {
    file: 'input.json',
    format: 'json',
    limits: { maxColumns: 3 },
  })
  assert.equal(report.status, 'incomplete')
  assert.equal(ruleIds(report).includes('too-many-columns'), true)
})

test('maxDepth refuses a record nested past the limit and does not parse it', async () => {
  const deep = '[{"a":{"b":{"c":{"d":1}}}}]'
  const report = await profileText(deep, { file: 'input.json', format: 'json', limits: { maxDepth: 3 } })

  assert.equal(report.status, 'incomplete')
  const finding = report.findings.find((entry) => entry.ruleId === 'record-too-deep')
  assert.match(finding.message, /maxDepth limit of 3/)
  assert.equal(report.summary.skipped, 1)
})

test('a record at exactly maxDepth is profiled; one level deeper is refused', async () => {
  // `{"a":{"b":{"c":1}}}` nests three levels, which is the limit itself -- the
  // record this test is named for. The record below it nests four, and the only
  // difference between the two runs is that one level.
  const exact = await profileText('[{"a":{"b":{"c":1}}}]', {
    file: 'input.json',
    format: 'json',
    limits: { maxDepth: 3 },
  })
  assert.equal(exact.status, 'pass')
  assert.deepEqual(ruleIds(exact), [])
  assert.equal(exact.summary.checked, 1)

  const over = await profileText('[{"a":{"b":{"c":{"d":1}}}}]', {
    file: 'input.json',
    format: 'json',
    limits: { maxDepth: 3 },
  })
  assert.equal(over.status, 'incomplete')
  assert.equal(ruleIds(over).includes('record-too-deep'), true)
  assert.equal(over.summary.skipped, 1)
})

test('maxFindings caps the report and says that it did', async () => {
  const rows = Array.from({ length: 20 }, (_, index) => `${index},1,2,extra`).join('\n')
  const report = await profileText(`a,b,c\n${rows}\n`, csv({ limits: { maxFindings: 5 } }))

  assert.equal(report.status, 'incomplete')
  assert.equal(report.findings.length, 5)
  assert.equal(report.findings.filter((finding) => finding.ruleId === 'too-many-findings').length, 1)
  assert.match(report.findings.find((entry) => entry.ruleId === 'too-many-findings').message, /maxFindings limit of 5/)
})

test('maxMillis ends the run through the injected clock', async () => {
  // The clock is injected, so the test is deterministic: it does not wait, it
  // just says time passed. Nothing about the elapsed time reaches the report.
  let calls = 0
  const clock = () => (calls++ === 0 ? 0 : 5000)
  const text = `id\n${Array.from({ length: 10 }, (_, index) => index).join('\n')}\n`

  const report = await profileText(text, csv({ limits: { maxMillis: 100 }, clock }))
  assert.equal(report.status, 'incomplete')
  assert.match(report.findings.find((entry) => entry.ruleId === 'time-limit-exceeded').message, /maxMillis limit of 100/)
  assert.equal(report.summary.checked >= 1, true, 'the run got as far as a record before it stopped')

  const generous = await profileText(text, csv({ limits: { maxMillis: 100000 }, clock: () => 0 }))
  assert.equal(generous.status, 'pass')
  assert.equal(generous.summary.checked, 10)
})

test('maxMillis may be zero, which exhausts the budget before the first record', async () => {
  const report = await profileText('id\n1\n2\n', csv({ limits: { maxMillis: 0 }, clock: () => 0 }))
  assert.equal(report.status, 'incomplete')
  assert.equal(ruleIds(report).includes('time-limit-exceeded'), true)
})

test('a clock that is not a function is a configuration error', async () => {
  await assert.rejects(() => profileText('id\n1\n', csv({ clock: 0 })), /Clock must be a function/)
})

test('an unterminated quoted field makes the run incomplete, not merely failed', async () => {
  const report = await profileText('id,note\n1,"never closed\n2,swallowed\n', csv({}))
  assert.equal(report.status, 'incomplete')
  assert.equal(ruleIds(report).includes('unterminated-quoted-field'), true)
  assert.equal(report.summary.checked, 0)
})

test('a record that is not JSON leaves a gap, and the gap is admitted', async () => {
  const report = await profileText('[{"a":1},{oops},{"a":2}]', { file: 'input.json', format: 'json' })
  assert.equal(report.status, 'incomplete')
  assert.equal(ruleIds(report).includes('record-not-json'), true)
  assert.equal(report.summary.skipped, 1)
  assert.equal(report.summary.checked, 2, 'the records either side of it were still profiled')
})

test('a header cut short by the row limit stops the run instead of inventing column names', async () => {
  // The row limit applies to the header before anything is believed about it.
  // A truncated row keeps its field count and loses its text, so this header
  // would otherwise be read as `alpha`, `beta`, `g` and `` -- two names the
  // file does not contain -- and every record would be attributed to them, in
  // a report that says `pass`. The header is the schema: unread, there is
  // nothing to profile against.
  const report = await profileText('alpha,beta,gamma,delta\n1,2,3,4\n5,6,7,8\n', csv({ limits: { maxRowBytes: 12 } }))

  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  assert.equal(report.summary.columns, 0, 'no column name was invented from a header that was not read')
  assert.deepEqual(ruleIds(report), ['no-records-profiled', 'row-too-large'])
  assert.match(report.findings.find((finding) => finding.ruleId === 'row-too-large').message, /header row/)

  // A header inside the limit is read exactly as it is written, so the refusal
  // above is about the limit and not about headers.
  const fits = await profileText('alpha,beta,gamma,delta\n1,2,3,4\n', csv({ limits: { maxRowBytes: 22 } }))
  assert.equal(fits.status, 'pass')
  assert.deepEqual(fits.profile.columns.map((entry) => entry.name), ['alpha', 'beta', 'gamma', 'delta'])
  assert.equal(fits.summary.checked, 1)
})

test('a run whose only record a limit refused reports that it checked nothing', async () => {
  // records 1, checked 0. The empty-run guard is written in terms of `checked`
  // because a record that was found and refused is not a record that was
  // examined; keyed on `records` this warning would disappear exactly on the
  // runs that saw the least. Both findings are asserted, so the guard cannot
  // be satisfied by the row limit's own finding.
  const report = await profileText('id,note\n1,\u00e9\u00e9\u00e9\n', csv({ limits: { maxRowBytes: 7 } }))

  assert.equal(report.summary.records, 1)
  assert.equal(report.summary.checked, 0)
  assert.equal(report.summary.skipped, 1)
  assert.deepEqual(ruleIds(report), ['no-records-profiled', 'row-too-large'])
  assert.equal(report.summary.warnings, 1)
  assert.equal(report.status, 'incomplete')
})

test('a limit that is not an integer, or below its floor, is refused', async () => {
  await assert.rejects(() => profileText('a\n1\n', csv({ limits: { maxRecords: 1.5 } })), /must be an integer/)
  await assert.rejects(() => profileText('a\n1\n', csv({ limits: { maxRowBytes: 0 } })), /at least 1/)
  await assert.rejects(() => profileText('a\n1\n', csv({ limits: { maxMillis: -1 } })), /at least 0/)
})
