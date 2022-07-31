import assert from 'node:assert/strict'
import test from 'node:test'

import { formatReport, mask, profileText } from '../src/index.mjs'

/**
 * Two guarantees that share a mechanism, and a defect class each.
 *
 * **Redaction.** An import file is where personal data lives. No field value
 * reaches the report as itself: a sample is a record number and a masked shape.
 * The test is not that the mask function works in isolation -- it is that a
 * value written into an input never appears in the report produced from it.
 *
 * **Sanitisation.** Stripping C0 and the line separators is not sanitising. The
 * C1 range forges report lines (`U+0085` NEL is a line break to a great many
 * readers, `U+009B` is the 8-bit CSI), and `U+202E` reverses displayed text.
 * The strip must cover every untrusted string that reaches output, so each
 * class below is pushed through an **identifier** -- a column name, a JSON key,
 * a file label -- and not only through an excerpt field.
 */

const character = (code) => String.fromCharCode(code)

const FORBIDDEN = [
  ['C0 (newline)', 0x0a],
  ['C0 (escape)', 0x1b],
  ['DEL', 0x7f],
  ['C1 (NEL)', 0x85],
  ['C1 (CSI)', 0x9b],
  ['line separator', 0x2028],
  ['paragraph separator', 0x2029],
  ['left-to-right mark', 0x200e],
  ['right-to-left override', 0x202e],
  ['first strong isolate', 0x2066],
]

/** Every forbidden code point present in a rendered report. */
function offenders(text) {
  const found = []
  for (const point of text) {
    const code = point.codePointAt(0)
    const forbidden =
      (code <= 0x1f && point !== '\n') ||
      code === 0x7f ||
      (code >= 0x80 && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    if (forbidden) found.push(code)
  }
  return found
}

/* Redaction. */

test('no field value from the input appears anywhere in the report', async () => {
  const secrets = ['alice@example.test', '+44 7700 900123', 'Wisteria Lodge, Flat 4b', 'NHS-4429-8813']
  const csv = [
    'id,contact,phone,address,record_ref',
    `1,${secrets[0]},"${secrets[1]}","${secrets[2]}",${secrets[3]}`,
    '2,not-an-address,7,"Second line",4429',
    '',
  ].join('\n')

  const report = await profileText(csv, { file: 'people.csv', format: 'csv' })
  const rendered = `${JSON.stringify(report)}\n${formatReport(report)}`

  assert.equal(report.findings.length > 0, true, 'the report has findings, so evidence was emitted')
  for (const secret of secrets) {
    assert.equal(rendered.includes(secret), false, `${secret} must not reach the report`)
  }
  // And the profile is still useful: the shape survived even though the value
  // did not.
  assert.equal(rendered.includes('aaaaa@aaaaaaa.aaaa'), true)
})

test('an oversized or drifted record is referenced by number and masked shape, never quoted', async () => {
  const csv = 'id,name,note\n1,Ann,ok\n2,Beatrice Hollis,extra,stray\n'
  const report = await profileText(csv, { file: 'people.csv', format: 'csv' })
  const finding = report.findings.find((entry) => entry.ruleId === 'row-field-count-drift')

  assert.equal(finding.record, 2, 'the sample reference is a record number')
  assert.equal(finding.line, 3)
  assert.equal(finding.evidence.includes('Beatrice'), false)
  assert.equal(finding.evidence, '9,Aaaaaaaa Aaaaaa,aaaaa,aaaaa')
})

test('the mask keeps shape and discards content', () => {
  assert.equal(mask('alice@example.com'), 'aaaaa@aaaaaaa.aaa')
  assert.equal(mask('2026-01-04'), '9999-99-99')
  assert.equal(mask('SKU-00417'), 'AAA-99999')
  assert.equal(mask('Ann'), 'Aaa')
  assert.equal(mask(''), '')
})

test('a masked sample is bounded, and says that it was cut', () => {
  const masked = mask('x'.repeat(200))
  assert.equal(masked.length, 51)
  assert.equal(masked.endsWith('...'), true)
})

/* Sanitisation, class by class, through an identifier. */

for (const [label, code] of FORBIDDEN) {
  test(`${label} is stripped when it arrives through a CSV column name`, async () => {
    const name = `am${character(code)}ount`
    const csv = `id,"${name}"\n1,10\n2,two\n`
    const report = await profileText(csv, { file: 'input.csv', format: 'csv' })
    const rendered = `${JSON.stringify(report)}\n${formatReport(report)}`

    assert.deepEqual(offenders(rendered), [], `${label} must not survive into the report`)
    // The column did reach the report -- this is not passing because the name
    // was dropped altogether.
    assert.equal(rendered.includes('am ount'), true)
    assert.equal(report.findings.some((finding) => finding.ruleId === 'column-type-mixed'), true)
  })

  test(`${label} is stripped when it arrives through a JSON key`, async () => {
    const key = `sk${character(code)}u`
    const json = `[{${JSON.stringify(key)}:"A",${JSON.stringify(key)}:"B"}]`
    const report = await profileText(json, { file: 'input.json', format: 'json' })
    const rendered = `${JSON.stringify(report)}\n${formatReport(report)}`

    assert.deepEqual(offenders(rendered), [], `${label} must not survive into the report`)
    assert.equal(report.findings.some((finding) => finding.ruleId === 'duplicate-object-key'), true)
    assert.equal(rendered.includes('sk u'), true, 'the key reached the report, sanitised')
  })

  test(`${label} is stripped when it arrives through a field value`, async () => {
    const csv = `id,note\n1,"ab${character(code)}cd"\n2,,stray\n`
    const report = await profileText(csv, { file: 'input.csv', format: 'csv' })
    const rendered = `${JSON.stringify(report)}\n${formatReport(report)}`
    assert.deepEqual(offenders(rendered), [], `${label} must not survive into the report`)
  })

  test(`${label} is stripped when it arrives through the file label`, async () => {
    const report = await profileText('id\n1\n', { file: `in${character(code)}put.csv`, format: 'csv' })
    const rendered = `${JSON.stringify(report)}\n${formatReport(report)}`
    assert.deepEqual(offenders(rendered), [], `${label} must not survive into the report`)
    assert.equal(report.profile.file, 'in put.csv')
  })
}

test('a column name carrying a newline cannot forge a line in the human report', async () => {
  const forged = 'note"\nERROR  forged.csv/columns/x column-type-mixed everything is fine'
  const csv = `id,"${forged.replace(/"/g, '""')}"\n1,10\n2,two\n`
  const report = await profileText(csv, { file: 'input.csv', format: 'csv' })
  const text = formatReport(report)

  const errorLines = text.split('\n').filter((line) => line.startsWith('ERROR'))
  assert.equal(errorLines.length, 1, 'exactly the one real error line, and none forged by a name')
  assert.equal(text.includes('everything is fine'), true, 'the text is still shown, on one line')
})
