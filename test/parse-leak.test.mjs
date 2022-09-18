import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { parseFailureDetail } from '../src/index.mjs'

/**
 * The redaction guarantee on the path where it was not being kept.
 *
 * `test/redaction.test.mjs` proves that a value which was PROFILED never
 * reaches the report as itself. A record that does not parse is never profiled,
 * so it took a different path -- and on that path V8 handed the record straight
 * back: `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON` is the
 * whole record when it is short, and a window around the offence when it is
 * not. `record-not-json` interpolated that message, so the report carried a raw
 * record beside a correctly masked `evidence` field on the very same finding.
 *
 * That is the worst version of the defect: a record that cannot be parsed is a
 * record nobody has validated, and this tool reads other people's imports.
 *
 * Neither `sanitize` nor `excerpt` closes it. One replaces control characters;
 * the other trims from the END while the quoted span sits at the FRONT, well
 * inside the 200-character message limit.
 *
 * The canary is AWS's own published documentation placeholder, not a
 * credential. It is checked down to eight characters, because half a leak is
 * still a leak.
 */

const execute = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/csv-json-import-profiler.mjs')
const CANARY = 'AKIAIOSFODNN7EXAMPLE'
const SHORTEST_PREFIX = 8

async function run(args) {
  try {
    const { stdout, stderr } = await execute(process.execPath, [CLI, ...args], {
      cwd: projectDirectory,
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

async function withBase(body) {
  const base = await mkdtemp(join(tmpdir(), 'csv-json-import-profiler-leak-'))
  try {
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

function assertNoCanary(stream, where) {
  for (let length = CANARY.length; length >= SHORTEST_PREFIX; length -= 1) {
    const prefix = CANARY.slice(0, length)
    assert.ok(
      !stream.includes(prefix),
      `${where} carries ${length} characters of the canary: ${JSON.stringify(stream)}`,
    )
  }
}

test('a record that is nothing but a credential is not echoed by either report', async () => {
  await withBase(async (base) => {
    const input = join(base, 'import.jsonl')
    await writeFile(input, `{"id":1,"name":"a"}\n${CANARY}\n`)

    // Both renderings, because the human report and the JSON report are built
    // from the same finding and a leak in one is a leak in both.
    for (const args of [[], ['--json']]) {
      const result = await run(['--input', input, ...args])
      assert.equal(result.code, 2, 'a record that was not profiled makes the run incomplete')
      assertNoCanary(result.stdout, `stdout for ${JSON.stringify(args)}`)
      assertNoCanary(result.stderr, `stderr for ${JSON.stringify(args)}`)
    }
  })
})

test('a credential inside a broken record is not echoed either', async () => {
  await withBase(async (base) => {
    const input = join(base, 'import.json')
    // V8 quotes a WINDOW around the offence, not only the head of the record,
    // so a secret in the middle of a broken record leaks just as readily.
    await writeFile(input, `[{"id":1}, {"token": ${CANARY}}]`)

    const result = await run(['--input', input, '--json'])
    assertNoCanary(result.stdout, 'stdout')
    assertNoCanary(result.stderr, 'stderr')
  })
})

test('the --out file does not carry the record either', async () => {
  await withBase(async (base) => {
    const input = join(base, 'import.jsonl')
    const out = join(base, 'profile.json')
    await writeFile(input, `{"id":1}\n${CANARY}\n`)

    await run(['--input', input, '--json', '--out', out])
    assertNoCanary(await readFile(out, 'utf8'), 'the --out report')
  })
})

test('the finding still says what was wrong and where', async () => {
  await withBase(async (base) => {
    const input = join(base, 'import.jsonl')
    await writeFile(input, '{"id":1}\n{"a": 1 "b": 2}\n')

    const result = await run(['--input', input, '--json'])
    const report = JSON.parse(result.stdout)
    const finding = report.findings.find((entry) => entry.ruleId === 'record-not-json')
    assert.ok(finding !== undefined, 'the record was refused as invalid JSON')
    // A diagnostic that says nothing is a different defect: position, line and
    // column are V8's useful half and none of them is record content.
    assert.match(finding.message, /at position 8 \(line 1 column 9\)/)
    assert.equal(finding.record, 2, 'the record number still locates it in the file')
    assert.equal(finding.line, 2, 'the line number still locates it in the file')
  })
})

test('parseFailureDetail keeps the position and drops the quoted record', () => {
  const cases = [
    [CANARY, "unexpected token 'A'"],
    [`{"a": ${CANARY}}`, "unexpected token 'A'"],
    ['ssn 123-45-6789', "unexpected token 's'"],
    [
      '{"a": 1 "b": 2}',
      "Expected ',' or '}' after property value in JSON at position 8 (line 1 column 9)",
    ],
    [`{"a":"${CANARY}`, 'Unterminated string in JSON at position 26 (line 1 column 27)'],
    ['', 'Unexpected end of JSON input'],
    // A record that merely CONTAINS "at position" must not smuggle itself
    // through: matching that phrase before the quoting shape would keep the
    // quoted span whenever the record supplied the phrase itself.
    [`${CANARY} at position 9 (line 1 column 10)`, "unexpected token 'A'"],
  ]
  for (const [text, expected] of cases) {
    try {
      JSON.parse(text)
      assert.fail(`${JSON.stringify(text)} was supposed to be unparseable`)
    } catch (error) {
      assert.equal(parseFailureDetail(error), expected)
    }
  }
})

test('a non-Error, and an error with no message, still produce a usable detail', () => {
  assert.equal(parseFailureDetail(undefined), 'it could not be parsed as JSON')
  assert.equal(parseFailureDetail({}), 'it could not be parsed as JSON')
  assert.equal(parseFailureDetail(new Error('')), 'it could not be parsed as JSON')
})
