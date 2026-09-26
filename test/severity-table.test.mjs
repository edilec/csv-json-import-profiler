import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { RULE_SEVERITY, SEVERITY_VALUES, createFinding } from '../src/index.mjs'

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The severity table as a source of truth.
 *
 * These tests assert that the table, the documented catalog and the shipped
 * source agree. That is worth having and it is *not* the guarantee: three
 * declarations that agree with each other can be edited together, and one tool
 * in this catalog had 40 of 52 error rules survive exactly that flip.
 *
 * The guarantee lives in `test/severity-exit.test.mjs`, which runs the real
 * binary and asserts the exit code. An exit code cannot be edited at all.
 */

async function readProjectFile(relativePath) {
  return readFile(resolve(projectDirectory, relativePath), 'utf8')
}

async function documentedSeverities() {
  const text = await readProjectFile('docs/import-profile-rules.md')
  const rows = [...text.matchAll(/\|\s*`([a-z0-9-]+)`\s*\|\s*(error|warning|info)\s*\|/g)]
  return Object.fromEntries(rows.map((row) => [row[1], row[2]]))
}

test('the documented rule catalog matches the severity table exactly', async () => {
  const documented = await documentedSeverities()

  assert.equal(Object.keys(documented).length, 28)
  assert.deepEqual(
    Object.keys(documented).sort(),
    Object.keys(RULE_SEVERITY).sort(),
    'docs/import-profile-rules.md and RULE_SEVERITY list different rules',
  )
  assert.deepEqual(documented, { ...RULE_SEVERITY })
})

test('every rule the source emits is defined in the severity table', async () => {
  const source = `${await readProjectFile('src/profile.mjs')}\n${await readProjectFile('src/index.mjs')}`
  const emitted = new Set([...source.matchAll(/ruleId:\s*'([a-z0-9-]+)'/g)].map((match) => match[1]))
  const named = new Set([...source.matchAll(/noteInput\(\s*\n?\s*'([a-z0-9-]+)'/g)].map((match) => match[1]))

  assert.equal(emitted.size + named.size > 20, true, 'the rule scan found suspiciously few construction sites')
  for (const ruleId of [...emitted, ...named]) {
    assert.ok(Object.hasOwn(RULE_SEVERITY, ruleId), `${ruleId} is emitted but missing from RULE_SEVERITY`)
  }
})

test('no severity literal is written at a finding construction site', async () => {
  // A `severity:` beside a `ruleId:` is the defect this table exists to
  // prevent: it lets one rule be downgraded without the table, the docs or a
  // test noticing.
  for (const path of ['src/profile.mjs', 'src/index.mjs', 'bin/csv-json-import-profiler.mjs']) {
    const source = await readProjectFile(path)
    const literals = [...source.matchAll(/severity:\s*'(error|warning|info)'/g)]
    assert.equal(literals.length, 0, `${path} writes a severity literal instead of reading RULE_SEVERITY`)
  }
})

test('an unknown rule id throws rather than defaulting to a severity', () => {
  assert.throws(
    () => createFinding({ ruleId: 'column-type-mixe', file: 'a.csv', pointer: '/columns/a', message: 'typo' }),
    /not in RULE_SEVERITY/,
  )
  // Including the inherited property names an object would otherwise answer to.
  assert.throws(
    () => createFinding({ ruleId: 'toString', file: 'a.csv', pointer: '/columns/a', message: 'x' }),
    /not in RULE_SEVERITY/,
  )
})

test('every severity in the table is one of the declared values', () => {
  for (const [ruleId, severity] of Object.entries(RULE_SEVERITY)) {
    assert.ok(SEVERITY_VALUES.includes(severity), `${ruleId} has severity ${severity}`)
  }
})

test('the table is frozen, so nothing can edit it at run time', () => {
  assert.equal(Object.isFrozen(RULE_SEVERITY), true)
})

test('every rule severity is pinned here, rule by rule', () => {
  // The table and the documented catalog are asserted against each other, so a
  // coordinated edit to both agrees with itself. This is the third copy,
  // written out by hand: a downgrade has to walk past an expectation that
  // shares no source with either of them. It is still only a declaration --
  // the behavioural pins are in test/severity-exit.test.mjs.
  assert.deepEqual({ ...RULE_SEVERITY }, {
    'column-all-null': 'warning',
    'column-integer-leading-zeros': 'warning',
    'column-integer-unsafe': 'warning',
    'column-null-ratio-high': 'warning',
    'column-type-mixed': 'error',
    'column-value-padded': 'warning',
    'duplicate-header-key': 'error',
    'duplicate-object-key': 'error',
    'header-column-unnamed': 'warning',
    'input-escapes-root': 'error',
    'input-has-bom': 'warning',
    'input-mixed-line-endings': 'warning',
    'input-not-an-array': 'error',
    'input-not-utf8': 'error',
    'input-too-large': 'error',
    'input-unreadable': 'error',
    'no-records-profiled': 'warning',
    'record-key-drift': 'warning',
    'record-not-an-object': 'error',
    'record-not-json': 'error',
    'record-too-deep': 'error',
    'row-field-count-drift': 'error',
    'row-too-large': 'error',
    'time-limit-exceeded': 'error',
    'too-many-columns': 'error',
    'too-many-findings': 'error',
    'too-many-records': 'error',
    'unterminated-quoted-field': 'error',
  })
})
