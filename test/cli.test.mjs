import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/csv-json-import-profiler.mjs')

/**
 * The CLI surface: the streams, the exit codes and the output destination.
 *
 * The stream contract matters as much as the verdict. A consumer pipes stdout
 * into a JSON parser, so stdout carries the report and nothing else, and a
 * configuration error -- a run that never had a subject -- leaves stdout empty
 * rather than emitting a report about nothing.
 */

async function run(args, options = {}) {
  try {
    const { stdout, stderr } = await execute(process.execPath, [CLI, ...args], {
      cwd: options.cwd ?? projectDirectory,
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

async function withBase(body) {
  const base = await mkdtemp(join(tmpdir(), 'csv-json-import-profiler-cli-'))
  try {
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

test('--help explains the tool on stdout and exits 0', async () => {
  const { code, stdout, stderr } = await run(['--help'])
  assert.equal(code, 0)
  assert.equal(stderr, '')
  assert.match(stdout, /Usage:/)
  assert.match(stdout, /--max-row-bytes/)
  assert.match(stdout, /Exit codes:/)
  assert.match(stdout, /read-only/)
})

test('a clean input exits 0 and a failing input exits 1', async () => {
  const clean = await run(['--input', 'examples/orders-clean.csv'])
  assert.equal(clean.code, 0)
  assert.match(clean.stdout, /status pass/)

  const broken = await run(['--input', 'examples/orders-broken.csv'])
  assert.equal(broken.code, 1)
  assert.match(broken.stdout, /status fail/)
})

test('--json puts a parseable report on stdout and nothing else', async () => {
  const { code, stdout, stderr } = await run(['--input', 'examples/catalog-clean.json', '--json'])
  assert.equal(code, 0)
  assert.equal(stderr, '')
  const report = JSON.parse(stdout)
  assert.equal(report.tool, 'csv-json-import-profiler')
  assert.equal(report.status, 'pass')
})

test('an incomplete run puts the report on stdout, the diagnostic on stderr, and exits 2', async () => {
  await withBase(async (base) => {
    const target = join(base, 'input.csv')
    await writeFile(target, 'id,note\n1,ok\n2,"never closed\n')
    const { code, stdout, stderr } = await run(['--input', target, '--json'])

    assert.equal(code, 2)
    assert.equal(JSON.parse(stdout).status, 'incomplete')
    assert.match(stderr, /incomplete:/)
    assert.match(stderr, /Unknown is not a pass/)
  })
})

test('a configuration error leaves stdout empty', async () => {
  for (const args of [
    ['--input', 'examples/orders-clean.csv', '--verbose'],
    ['--json'],
    ['--input', 'examples/orders-clean.csv', '--input', 'examples/orders-broken.csv'],
    ['--input', 'examples/orders-clean.csv', '--max-records'],
    ['--input', 'examples/orders-clean.csv', '--max-records', 'ten'],
    ['--input', 'examples/orders-clean.csv', '--max-records', '0'],
    ['--input', 'examples/orders-clean.csv', '--max-null-ratio', '2'],
    ['--input', 'examples/orders-clean.csv', '--format', 'xml'],
    ['--input', 'examples/orders-clean.csv', '--delimiter', '||'],
    ['--input', 'examples/events-clean.jsonl', '--format', 'jsonl', '--format', 'json'],
  ]) {
    const { code, stdout, stderr } = await run(args)
    assert.equal(code, 2, `${args.join(' ')} must exit 2`)
    assert.equal(stdout, '', `${args.join(' ')} must leave stdout empty`)
    assert.notEqual(stderr, '')
  }
})

test('a file with no recognised extension must be told what it is', async () => {
  await withBase(async (base) => {
    const target = join(base, 'export')
    await writeFile(target, 'id,name\n1,Ann\n')

    const guessed = await run(['--input', target])
    assert.equal(guessed.code, 2)
    assert.equal(guessed.stdout, '')
    assert.match(guessed.stderr, /Cannot infer a format/)

    const declared = await run(['--input', target, '--format', 'csv'])
    assert.equal(declared.code, 0)
  })
})

test('--delimiter accepts a name or a character', async () => {
  await withBase(async (base) => {
    const target = join(base, 'input.csv')
    await writeFile(target, 'id;amount\n1;10\n2;20\n')

    const named = await run(['--input', target, '--delimiter', 'semicolon', '--json'])
    assert.equal(named.code, 0)
    assert.deepEqual(JSON.parse(named.stdout).profile.columns.map((column) => column.name), ['id', 'amount'])

    const literal = await run(['--input', target, '--delimiter', ';', '--json'])
    assert.equal(JSON.parse(literal.stdout).summary.columns, 2)

    const wrong = await run(['--input', target, '--json'])
    assert.equal(JSON.parse(wrong.stdout).summary.columns, 1, 'the wrong delimiter is visible, not corrected')
  })
})

test('--null-tokens teaches the profiler what a file writes for "no value"', async () => {
  await withBase(async (base) => {
    const target = join(base, 'input.csv')
    await writeFile(target, 'id,note\n1,NULL\n2,NULL\n3,NULL\n')

    const untaught = await run(['--input', target, '--json'])
    assert.equal(JSON.parse(untaught.stdout).summary.nulls, 0)

    const taught = await run(['--input', target, '--null-tokens', 'NULL,N/A', '--json'])
    const report = JSON.parse(taught.stdout)
    assert.equal(report.summary.nulls, 3)
    assert.equal(report.findings.some((finding) => finding.ruleId === 'column-all-null'), true)
  })
})

test('--max-millis is wired to the clock, so a zero budget ends the run', async () => {
  // The defect this pins: a documented limit that the CLI never passes through
  // is accepted and silently ignored.
  const { code, stdout } = await run(['--input', 'examples/orders-clean.csv', '--max-millis', '0', '--json'])
  assert.equal(code, 2)
  const report = JSON.parse(stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.findings.some((finding) => finding.ruleId === 'time-limit-exceeded'), true)
})

test('--out writes the JSON report to a separate destination', async () => {
  await withBase(async (base) => {
    const input = join(base, 'input.csv')
    const output = join(base, 'profile.json')
    await writeFile(input, 'id,amount\n1,10\n2,20\n')

    const { code, stdout } = await run(['--input', input, '--out', output])
    assert.equal(code, 0)
    assert.match(stdout, /status pass/, 'stdout still carries the human summary')

    const written = JSON.parse(await readFile(output, 'utf8'))
    assert.equal(written.tool, 'csv-json-import-profiler')
    assert.equal(written.summary.checked, 2)
  })
})

test('--out refuses to be the input, even by way of a symlink', async () => {
  await withBase(async (base) => {
    const input = join(base, 'input.csv')
    await writeFile(input, 'id,amount\n1,10\n')
    await symlink(input, join(base, 'alias.csv'))

    for (const target of [input, join(base, 'alias.csv')]) {
      const { code, stdout, stderr } = await run(['--input', input, '--out', target])
      assert.equal(code, 2)
      assert.equal(stdout, '')
      assert.match(stderr, /never rewrites what it profiles/)
    }
    assert.equal(await readFile(input, 'utf8'), 'id,amount\n1,10\n', 'the input is exactly as it was')
  })
})

test('--out refuses to replace an existing file unless told to', async () => {
  await withBase(async (base) => {
    const input = join(base, 'input.csv')
    const output = join(base, 'profile.json')
    await writeFile(input, 'id,amount\n1,10\n')
    await writeFile(output, 'keep me')

    const refused = await run(['--input', input, '--out', output])
    assert.equal(refused.code, 2)
    assert.equal(refused.stdout, '')
    assert.match(refused.stderr, /already exists/)
    assert.equal(await readFile(output, 'utf8'), 'keep me')

    const allowed = await run(['--input', input, '--out', output, '--overwrite'])
    assert.equal(allowed.code, 0)
    assert.equal(JSON.parse(await readFile(output, 'utf8')).tool, 'csv-json-import-profiler')
  })
})

test('--root reports relative paths and refuses an input that resolves outside it', async () => {
  await withBase(async (base) => {
    const root = join(base, 'inbox')
    await mkdir(join(root, 'day-1'), { recursive: true })
    const input = join(root, 'day-1', 'orders.csv')
    await writeFile(input, 'id,amount\n1,10\n')

    const inside = await run(['--input', input, '--root', root, '--json'])
    assert.equal(inside.code, 0)
    assert.equal(JSON.parse(inside.stdout).profile.file, 'day-1/orders.csv')

    const outside = await run(['--input', input, '--root', join(base, 'elsewhere')])
    assert.equal(outside.code, 2)
    assert.equal(outside.stdout, '', 'an unreadable root is a configuration error')
  })
})

test('a file inside a symlinked root is profiled, not falsely refused', async () => {
  // The over-correction this pins: comparing a real root against a path that
  // was not resolved refuses files that genuinely are inside the root. A false
  // refusal is a bug too.
  await withBase(async (base) => {
    const real = join(base, 'real')
    await mkdir(real)
    await writeFile(join(real, 'orders.csv'), 'id,amount\n1,10\n')
    await symlink(real, join(base, 'link'))

    const { code, stdout } = await run(['--input', join(base, 'link', 'orders.csv'), '--root', join(base, 'link'), '--json'])
    assert.equal(code, 0)
    const report = JSON.parse(stdout)
    assert.equal(report.status, 'pass')
    assert.equal(report.profile.file, 'orders.csv')
  })
})

test('the report is byte-identical between two runs of the binary', async () => {
  const first = await run(['--input', 'examples/catalog-broken.json', '--json'])
  const second = await run(['--input', 'examples/catalog-broken.json', '--json'])
  assert.equal(first.stdout, second.stdout)
  assert.equal(first.code, second.code)
  assert.equal(first.code, 1)
})
