import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/csv-json-import-profiler.mjs')

/**
 * Severity, pinned by what actually happens.
 *
 * `test/severity-table.test.mjs` asserts the table against the documented
 * catalog and against a hand-written copy. That is three declarations agreeing
 * with each other: an edit that changes all three at once passes every one of
 * those assertions, and a rule quietly demoted from `error` to `warning`
 * reaches exit 0 with the suite still green.
 *
 * These tests assert the consequence instead. Each case builds an input that
 * isolates one rule, runs the real binary, and pins the exact set of rules
 * raised, the report status and the process exit code. A demotion changes the
 * observable outcome -- `fail` becomes `pass`, exit 1 becomes exit 0 -- so no
 * coordinated edit to a table, a document and a test map can satisfy it.
 *
 * The rules that also make the run incomplete exit 2 whatever their severity
 * says, so for those the exit code alone would not notice a demotion. They are
 * pinned further down with literal inline counts and the severity word the
 * human report prints, in tests that share no map with anything else.
 */

async function withBase(body) {
  const base = await mkdtemp(join(tmpdir(), 'csv-json-import-profiler-severity-'))
  try {
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

/** Run the real binary twice over one input: once for JSON, once for the human report. */
async function profile(build, extraArguments = []) {
  return withBase(async (base) => {
    const target = await build(base)
    const invoke = async (args) => {
      try {
        const { stdout } = await run(process.execPath, [CLI, '--input', target, ...args], { cwd: projectDirectory })
        return { code: 0, stdout }
      } catch (error) {
        return { code: error.code, stdout: error.stdout }
      }
    }
    const json = await invoke(['--json', ...extraArguments])
    const human = await invoke(extraArguments)
    assert.equal(json.code, human.code, 'the two invocations must agree on the exit code')
    return { code: json.code, report: JSON.parse(json.stdout), text: human.stdout }
  })
}

/** A base holding one input file. */
function withInput(name, content) {
  return async (base) => {
    const target = join(base, name)
    await writeFile(target, content)
    return target
  }
}

const ruleIds = (report) => report.findings.map((finding) => finding.ruleId)

/*
 * Rules whose severity alone decides the verdict. Nothing else in these runs is
 * wrong, and none of them sets the incomplete flag, so `error` is the only
 * thing keeping each one out of a pass.
 */

const FAILING = [
  {
    ruleId: 'column-type-mixed',
    build: withInput('input.csv', 'id,amount\n1,10\n2,unpriced\n'),
  },
  {
    ruleId: 'duplicate-header-key',
    build: withInput('input.csv', 'id,ref,ref\n1,a,b\n'),
  },
  {
    ruleId: 'duplicate-object-key',
    build: withInput('input.json', '[{"sku":"A","sku":"B"}]'),
  },
  {
    ruleId: 'row-field-count-drift',
    build: withInput('input.csv', 'id,name\n1,Ann\n2,Bob,stray\n'),
  },
  {
    ruleId: 'record-not-an-object',
    build: withInput('input.json', '[{"a":1},7]'),
  },
]

for (const { ruleId, build } of FAILING) {
  test(`${ruleId} fails the run and exits 1`, async () => {
    const { code, report, text } = await profile(build)
    assert.deepEqual(ruleIds(report), [ruleId], 'the case isolates exactly this rule')
    assert.equal(report.status, 'fail')
    assert.equal(code, 1)
    assert.match(text, /^ERROR /m)
  })
}

/*
 * Rules that must not fail a run. Promoting one to `error` turns exit 0 into
 * exit 1, so these pin severity in the other direction.
 */

const PASSING = [
  { ruleId: 'column-all-null', build: withInput('input.csv', 'id,note\n1,\n2,\n') },
  { ruleId: 'column-integer-leading-zeros', build: withInput('input.csv', 'id,zip\n1,00471\n') },
  { ruleId: 'column-integer-unsafe', build: withInput('input.csv', 'id,big\n1,9007199254740993\n') },
  { ruleId: 'column-null-ratio-high', build: withInput('input.csv', 'id,note\n1,a\n2,\n3,\n') },
  { ruleId: 'column-value-padded', build: withInput('input.csv', 'id,note\n1,"a "\n2,"b "\n') },
  { ruleId: 'header-column-unnamed', build: withInput('input.csv', 'id,\n1,x\n') },
  { ruleId: 'input-mixed-line-endings', build: withInput('input.csv', 'id\r\n1\n2\n') },
  { ruleId: 'record-key-drift', build: withInput('input.json', '[{"a":1,"b":2},{"a":3,"b":4},{"a":5}]') },
]

for (const { ruleId, build } of PASSING) {
  test(`${ruleId} is reported without failing the run, and exits 0`, async () => {
    const { code, report, text } = await profile(build, ['--max-null-ratio', '0.5'])
    assert.equal(ruleIds(report).includes(ruleId), true)
    assert.equal(report.status, 'pass')
    assert.equal(code, 0)
    assert.equal(report.summary.errors, 0)
    assert.match(text, /^WARNING /m)
  })
}

test('a byte order mark is reported without failing the run, and exits 0', async () => {
  const { code, report } = await profile(async (base) => {
    const target = join(base, 'input.csv')
    // The byte order mark is written as an escape: a literal one in a source
    // file is invisible and would be the second-hardest bug in this repository.
    await writeFile(target, `${String.fromCharCode(0xfeff)}id,name\n1,Ann\n`)
    return target
  })
  assert.deepEqual(ruleIds(report), ['input-has-bom'])
  assert.equal(report.status, 'pass')
  assert.equal(code, 0)
})

/*
 * Rules that also make the run incomplete. Every one of these exits 2 whatever
 * its severity says, so the exit code alone cannot notice a demotion. Each test
 * below writes its expectation out literally -- the error count and the
 * severity word the human report prints -- and shares no table with the source,
 * the documentation, or the other tests in this file.
 */

test('input-not-utf8: one error, printed as ERROR, exit 2', async () => {
  const { code, report, text } = await profile(async (base) => {
    const target = join(base, 'input.csv')
    // A valid record first, so this run has evidence and the incomplete flag
    // on the decoding failure is what makes it exit 2.
    await writeFile(target, Buffer.from([0x69, 0x64, 0x0a, 0x31, 0x0a, 0x32, 0xff, 0x0a]))
    return target
  })
  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.match(text, /^ERROR .*input-not-utf8/m)
})

test('input-too-large: one error, printed as ERROR, exit 2', async () => {
  const { code, report, text } = await profile(
    withInput('input.csv', `id,name\n${'1,Ann\n'.repeat(40)}`),
    ['--max-input-bytes', '30'],
  )
  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.match(text, /^ERROR .*input-too-large/m)
})

test('input-unreadable: one error, printed as ERROR, exit 2', async () => {
  const { code, report, text } = await profile(async (base) => join(base, 'absent.csv'))
  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.match(text, /^ERROR .*input-unreadable/m)
})

test('input-not-an-array: one error, printed as ERROR, exit 2', async () => {
  // Content after a complete array: one record is profiled first, so the
  // incomplete flag on the framing failure is load bearing here.
  const { code, report, text } = await profile(withInput('input.json', '[{"a":1}] trailing'))
  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.match(text, /^ERROR .*input-not-an-array/m)
})

test('record-not-json: one error, printed as ERROR, exit 2', async () => {
  const { code, report, text } = await profile(withInput('input.json', '[{"a":1},{oops},{"a":2}]'))
  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.match(text, /^ERROR .*record-not-json/m)
})

test('record-too-deep: one error, printed as ERROR, exit 2', async () => {
  const { code, report, text } = await profile(
    withInput('input.json', '[{"a":1},{"a":{"b":{"c":1}}}]'),
    ['--max-depth', '2'],
  )
  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.match(text, /^ERROR .*record-too-deep/m)
})

test('row-too-large: one error, printed as ERROR, exit 2', async () => {
  const { code, report, text } = await profile(
    withInput('input.csv', `id,note\n1,${'x'.repeat(80)}\n2,ok\n`),
    ['--max-row-bytes', '20'],
  )
  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.match(text, /^ERROR .*row-too-large/m)
})

test('time-limit-exceeded: one error, printed as ERROR, exit 2', async () => {
  const { code, report, text } = await profile(withInput('input.csv', 'id\n1\n2\n'), ['--max-millis', '0'])
  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.match(text, /^ERROR .*time-limit-exceeded/m)
})

test('too-many-columns: one error, printed as ERROR, exit 2', async () => {
  // JSON keys arrive record by record, so the first record is profiled before
  // the limit is reached and the incomplete flag decides the exit code.
  const { code, report, text } = await profile(
    withInput('input.json', '[{"a":1,"b":2},{"c":3}]'),
    ['--max-columns', '2'],
  )
  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.match(text, /^ERROR .*too-many-columns/m)
})

test('too-many-records: one error, printed as ERROR, exit 2', async () => {
  const { code, report, text } = await profile(withInput('input.csv', 'id\n1\n2\n3\n4\n'), ['--max-records', '2'])
  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.match(text, /^ERROR .*too-many-records/m)
})

test('too-many-findings: one error, printed as ERROR, exit 2', async () => {
  const rows = Array.from({ length: 8 }, (_, index) => `${index},a,stray`).join('\n')
  const { code, report, text } = await profile(withInput('input.csv', `id,x\n${rows}\n`), ['--max-findings', '3'])
  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.findings.length, 3)
  assert.match(text, /^ERROR .*too-many-findings/m)
})

test('unterminated-quoted-field: one error, printed as ERROR, exit 2', async () => {
  const { code, report, text } = await profile(withInput('input.csv', 'id,note\n1,ok\n2,"never closed\n'))
  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.match(text, /^ERROR .*unterminated-quoted-field/m)
})

test('input-escapes-root: one error, printed as ERROR, exit 2', async () => {
  const result = await withBase(async (base) => {
    const root = join(base, 'inbox')
    const outside = join(base, 'elsewhere')
    await mkdir(root)
    await mkdir(outside)
    await writeFile(join(outside, 'secret.csv'), 'id,name\n1,Ann\n')
    await symlink(join(outside, 'secret.csv'), join(root, 'linked.csv'))

    try {
      const { stdout } = await run(
        process.execPath,
        [CLI, '--input', join(root, 'linked.csv'), '--root', root, '--json'],
        { cwd: projectDirectory },
      )
      return { code: 0, stdout }
    } catch (error) {
      return { code: error.code, stdout: error.stdout }
    }
  })

  const report = JSON.parse(result.stdout)
  assert.equal(result.code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 1)
  assert.equal(ruleIds(report).includes('input-escapes-root'), true)
  assert.equal(JSON.stringify(report).includes('Ann'), false, 'out-of-root content never reaches the report')
})

test('no-records-profiled: no error, printed as WARNING, exit 2', async () => {
  // The one incomplete rule that is a warning. Nothing about its severity keeps
  // this run out of a pass -- the incomplete flag is the whole of it, which is
  // why deleting that flag has to change this exit code.
  const { code, report, text } = await profile(withInput('input.csv', 'id,name\n'))
  assert.equal(code, 2)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 1)
  assert.match(text, /^WARNING .*no-records-profiled/m)
})
