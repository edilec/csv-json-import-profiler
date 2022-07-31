import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { byCodeUnit, formatReport, profileFile, profileText } from '../src/index.mjs'

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Ordering, pinned by what the report emits.
 *
 * Grepping this package's own source for `.localeCompare(` would not be a
 * determinism test: substituting `Intl.Collator` produces identical collation
 * drift with different source text, so the grep passes while the order silently
 * becomes machine-dependent. The tests below choose names whose order genuinely
 * differs between code-unit and collation ordering, push them through the real
 * report path, and assert the exact emitted order -- then assert that an
 * English collator disagrees, which is what makes the first assertion load
 * bearing.
 */

const pointers = (report) => report.findings.map((finding) => finding.location.pointer)

test('the comparator disagrees with an English collator wherever they differ', () => {
  const collator = new Intl.Collator('en')
  for (const [left, right] of [
    ['URLS', 'URL_ENTRIES'],
    ['README.md', 'assets'],
    ['Zebra', 'apple'],
  ]) {
    assert.equal(byCodeUnit(left, right), -1, `${left} must precede ${right} by code unit`)
    assert.equal(collator.compare(left, right) > 0, true, `a collator puts ${right} first, which is the disagreement`)
  }
  for (const [left, right] of [['a_b', 'aB'], ['step_two', 'stepTwo']]) {
    assert.equal(byCodeUnit(left, right), 1, `${right} must precede ${left} by code unit`)
    assert.equal(collator.compare(left, right) < 0, true, 'the collator disagrees in this direction too')
  }
})

test('column findings are emitted in code-unit order, not collation order', async () => {
  // Every one of these columns is mixed, so every one raises a finding and the
  // order of the findings is decided by the column names alone.
  const csv = 'README,URLS,URL_ENTRIES,Zebra,apple,assets\n1,1,1,1,1,1\ntext,text,text,text,text,text\n'
  const report = await profileText(csv, { file: 'input.csv', format: 'csv' })

  assert.deepEqual(pointers(report), [
    '/columns/README',
    '/columns/URLS',
    '/columns/URL_ENTRIES',
    '/columns/Zebra',
    '/columns/apple',
    '/columns/assets',
  ])

  const collated = [...pointers(report)].sort(new Intl.Collator('en').compare)
  assert.notDeepEqual(collated, pointers(report), 'a collator would have produced a different order')
})

test('the profile lists columns in the order the input declares them', async () => {
  // The findings are sorted; the profile is not. A column table reordered out
  // of the file's own order would be a different kind of lie.
  const csv = 'README,URLS,URL_ENTRIES,Zebra,apple,assets\n1,1,1,1,1,1\n'
  const report = await profileText(csv, { file: 'input.csv', format: 'csv' })
  assert.deepEqual(
    report.profile.columns.map((column) => column.name),
    ['README', 'URLS', 'URL_ENTRIES', 'Zebra', 'apple', 'assets'],
  )
})

test('record findings are ordered by number, so record 9 precedes record 10', async () => {
  const rows = Array.from({ length: 12 }, (_, index) => `${index + 1},a,b,stray`).join('\n')
  const report = await profileText(`id,x,y\n${rows}\n`, { file: 'input.csv', format: 'csv' })

  assert.deepEqual(
    report.findings.map((finding) => finding.record),
    Array.from({ length: 12 }, (_, index) => index + 1),
  )
  // The same numbers compared as text would put 10 before 9, which is what the
  // numeric comparison in the sort key exists to prevent.
  const asText = report.findings.map((finding) => String(finding.record)).sort(byCodeUnit)
  assert.notDeepEqual(asText, report.findings.map((finding) => String(finding.record)))
})

test('findings about the input come before columns, which come before records', async () => {
  const csv = 'id,amount\r\n1,10\n2,text\n3,a,b,stray\n'
  const report = await profileText(csv, { file: 'input.csv', format: 'csv' })
  assert.deepEqual(
    report.findings.map((finding) => finding.ruleId),
    ['input-mixed-line-endings', 'column-type-mixed', 'row-field-count-drift'],
  )
})

test('two runs over the same bytes produce byte-identical output', async () => {
  const input = join(projectDirectory, 'examples/orders-broken.csv')
  const first = await profileFile({ input })
  const second = await profileFile({ input })

  assert.equal(JSON.stringify(first), JSON.stringify(second))
  assert.equal(formatReport(first), formatReport(second))
  assert.equal(first.findings.length >= 5, true, 'the comparison is over a report with something in it')
})

test('the same content profiles identically whether it is read from a file or from memory', async () => {
  const input = join(projectDirectory, 'examples/catalog-broken.json')
  const fromFile = await profileFile({ input })
  const fromMemory = await profileText(await readFile(input, 'utf8'), {
    file: 'catalog-broken.json',
    format: 'json',
  })
  assert.equal(JSON.stringify(fromFile), JSON.stringify(fromMemory))
})

/**
 * A secondary check. The behavioural tests above are the guarantee; this one
 * catches a reintroduction early and is not a substitute for them.
 */
test('the shipped source reads no clock, locale or random source', async () => {
  const parts = []
  for (const directory of ['src', 'bin']) {
    for (const name of await readdir(join(projectDirectory, directory))) {
      parts.push(await readFile(join(projectDirectory, directory, name), 'utf8'))
    }
  }
  // Comment lines are dropped before the scan: these modules discuss
  // `localeCompare`, `Intl.Collator` and `new Date` in prose precisely because
  // they are refused, and a scan that could not tell code from prose would
  // force the explanations out of the source.
  const source = parts
    .join('\n')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !(trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//'))
    })
    .join('\n')

  for (const forbidden of ['.localeCompare(', 'new Intl.Collator(', 'Math.random(', 'Date.now(', 'new Date(']) {
    assert.equal(source.includes(forbidden), false, `${forbidden} must not appear in the shipped source`)
  }
  for (const forbidden of ['node:http', 'node:https', 'node:net', 'node:dgram', 'fetch(', 'node:child_process']) {
    assert.equal(source.includes(forbidden), false, `${forbidden} must not appear in the shipped source`)
  }
})
