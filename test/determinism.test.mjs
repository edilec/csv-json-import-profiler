import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { RULE_SEVERITY, SECTIONS, byCodeUnit, formatReport, profileFile, profileText, sortFindings } from '../src/index.mjs'
import { FAMILIES, TYPES } from '../src/values.mjs'

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

test('findings merged from several files are ordered by file, in code-unit order', () => {
  // One run profiles one file, so the file key of the sort is reachable only
  // through a caller merging findings from several runs into one report --
  // which is why `sortFindings` is exported. `README.md` precedes `assets.csv`
  // by code unit and follows it under an English collator, so the two orders
  // are told apart here rather than assumed to be the same.
  const row = (file) => ({
    file,
    section: SECTIONS.input,
    record: 0,
    line: 0,
    pointer: '/input',
    ruleId: 'input-has-bom',
    message: 'the input starts with a byte order mark',
  })
  const ordered = sortFindings(['assets.csv', 'Zebra.csv', 'README.md', 'apple.csv'].map(row)).map((entry) => entry.file)

  assert.deepEqual(ordered, ['README.md', 'Zebra.csv', 'apple.csv', 'assets.csv'])
  assert.notDeepEqual(
    [...ordered].sort(new Intl.Collator('en').compare),
    ordered,
    'a collator would have produced a different order',
  )
})

test('key drift lists the missing and the extra names in code-unit order', async () => {
  // Both lists come from the input, so their alphabet is whatever the file
  // holds: `README` before `apple` by code unit and after it by collation,
  // `a-b` before `a_b` by code unit and after it by collation. The first
  // record declares its keys in neither order, so the emitted order is the
  // sort's answer and not the file's.
  const first = '{"Zebra":1,"apple":1,"README":1,"assets":1,"URL_ENTRIES":1}'
  const second = '{"apricot":1,"a_b":1,"Yak":1,"a-b":1,"Zebra":1}'
  const report = await profileText(`[${first},${second}]`, { file: 'input.json', format: 'json' })

  const drift = report.findings.find((finding) => finding.ruleId === 'record-key-drift')
  assert.notEqual(drift, undefined)
  assert.equal(
    drift.message,
    'Record 2 has a different key set from the first record ' +
      '(missing 4: README, URL_ENTRIES, apple, assets; extra 4: Yak, a-b, a_b, apricot).',
  )

  // The same two lists under an English collator, which is what the assertion
  // above exists to exclude.
  const collator = new Intl.Collator('en')
  assert.equal(['README', 'URL_ENTRIES', 'apple', 'assets'].sort(collator.compare).join(', '), 'apple, assets, README, URL_ENTRIES')
  assert.equal(['Yak', 'a-b', 'a_b', 'apricot'].sort(collator.compare).join(', '), 'a_b, a-b, apricot, Yak')
})

test('a mixed column orders its families, its types and its samples the same way everywhere', async () => {
  // One column holding every type this profiler knows. Four places order that
  // column: the evidence string, the family list, the type map and the sample
  // list. Each is asserted whole, so reversing or dropping any one of the four
  // sorts changes an emitted value.
  const rows = [
    '{"v":"abc"}',
    '{"v":{"k":1}}',
    '{"v":7}',
    '{"v":"2020-01-02"}',
    '{"v":true}',
    '{"v":1.5}',
    '{"v":""}',
    '{"v":null}',
  ]
  const report = await profileText(`[${rows.join(',')}]`, { file: 'input.json', format: 'json' })
  const mixed = report.findings.find((finding) => finding.ruleId === 'column-type-mixed')
  const column = report.profile.columns[0]

  // The evidence keeps the first four families in order, not the first four
  // the file happened to show.
  assert.equal(
    mixed.evidence,
    'record 5 boolean/boolean aaaa | record 4 date/date 9999-99-99 | record 3 numeric/integer 9 | record 2 structured/structured {aaaaaa}',
  )
  assert.match(mixed.message, /holds 5 type families \(boolean, date, numeric, structured, text\)/)
  assert.deepEqual(column.families, ['boolean', 'date', 'numeric', 'structured', 'text'])
  assert.deepEqual(Object.keys(column.types), [
    'boolean',
    'date',
    'empty',
    'integer',
    'null',
    'number',
    'string',
    'structured',
  ])
  assert.deepEqual(column.samples.map((sample) => sample.family), ['boolean', 'date', 'numeric', 'structured'])
  // The JSON report is the serialised object, so the type map's key order is
  // an emitted order and not an implementation detail.
  assert.match(
    JSON.stringify(report.profile.columns[0].types),
    /^\{"boolean":1,"date":1,"empty":1,"integer":1,"null":1,"number":1,"string":1,"structured":1\}$/,
  )
})

test('the closed vocabularies this tool orders are ones a collator would order identically', () => {
  // Rule ids, family names and type names are spelled in lowercase ASCII and
  // hyphens, and over that alphabet an English collator and code-unit order
  // agree on every pair. That is why substituting a collator into the sorts
  // over these three vocabularies changes nothing observable -- and why this
  // test is the guard for them: a rule id or family name introduced outside
  // that alphabet would make the substitution matter, and would fail here
  // before it could drift between machines.
  const collator = new Intl.Collator('en')
  const sign = (value) => (value < 0 ? -1 : value > 0 ? 1 : 0)
  for (const [label, values] of [
    ['rule ids', Object.keys(RULE_SEVERITY)],
    ['families', [...FAMILIES]],
    ['types', [...TYPES]],
  ]) {
    assert.equal(values.length > 1, true, `${label} must have something to order`)
    for (const left of values) {
      for (const right of values) {
        assert.equal(
          sign(byCodeUnit(left, right)),
          sign(collator.compare(left, right)),
          `${label}: "${left}" and "${right}" order differently by code unit and by collation`,
        )
      }
    }
  }
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
