import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
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

test('a control character in an argument cannot forge a line on stderr', async () => {
  // argv is as untrusted as the file it names: a path arrives from a directory
  // listing, a CI variable or a glob. ESC opens a terminal escape sequence and
  // U+2028 is a line break to a great many readers, so a diagnostic quoting
  // either back verbatim can be made to read as something else entirely --
  // which is exactly what this tool refuses to let the input's own bytes do.
  const escape = '\u001b[2J'
  const unknown = await run(['--input', 'examples/orders-clean.csv', `--bad${escape}option\u2028tail`])
  assert.equal(unknown.code, 2)
  assert.match(unknown.stderr, /Unknown option/)
  assert.equal(unknown.stderr.includes('\u001b'), false, 'no escape character reaches stderr')
  assert.equal(unknown.stderr.includes('\u2028'), false, 'no line separator reaches stderr')
  assert.equal(unknown.stderr.includes('tail'), true, 'the argument is still quoted back, without its controls')

  const missing = await run([
    '--input', 'examples/orders-clean.csv',
    '--out', `/nowhere${escape}/profile.json`,
    '--out-root', '/',
  ])
  assert.equal(missing.code, 2)
  assert.match(missing.stderr, /--out names a directory that does not exist/)
  assert.equal(missing.stderr.includes('\u001b'), false, 'no escape character reaches stderr')
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

    const { code, stdout } = await run(['--input', input, '--out', output, '--out-root', base])
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

    // The input under its own name is refused by identity; the symlink is
    // refused a step earlier, on sight, because resolving it is the dangerous
    // act. Two different refusals, one outcome: the input is not written to.
    const direct = await run(['--input', input, '--out', input, '--out-root', base])
    assert.equal(direct.code, 2)
    assert.equal(direct.stdout, '')
    assert.match(direct.stderr, /same file as an input/)

    const viaLink = await run(['--input', input, '--out', join(base, 'alias.csv'), '--out-root', base])
    assert.equal(viaLink.code, 2)
    assert.equal(viaLink.stdout, '')
    assert.match(viaLink.stderr, /symbolic link/)
    assert.equal(await readFile(input, 'utf8'), 'id,amount\n1,10\n', 'the input is exactly as it was')
  })
})

test('--out refuses to be the input by way of a hard link, which has no target to resolve', async () => {
  // The destructive case a real-path comparison cannot see. A symbolic link
  // resolves to its target, so comparing real paths catches it. A hard link has
  // no target: two names for one inode resolve to two different real paths, the
  // comparison says "different file", and the write destroys the input. Hard
  // links are ordinary in build trees -- `cp -l`, package stores, backups.
  await withBase(async (base) => {
    const input = join(base, 'input.csv')
    const alias = join(base, 'alias.csv')
    const content = 'id,amount\n1,10\n'
    await writeFile(input, content)
    await link(input, alias)

    // --overwrite is the dangerous combination: without it the run stops
    // because the destination exists, which hides the destruction rather than
    // preventing it. Both names are tried as the input, because neither of them
    // is the "real" one.
    for (const [subject, destination] of [[input, alias], [alias, input]]) {
      const { code, stdout, stderr } = await run([
        '--input', subject,
        '--out', destination,
        '--out-root', base,
        '--overwrite',
      ])
      assert.equal(code, 2)
      assert.equal(stdout, '', 'a refused destination is a configuration error, so stdout stays empty')
      assert.match(stderr, /same file as an input/)
      assert.equal(await readFile(input, 'utf8'), content, 'the input is exactly as it was')
      assert.equal(await readFile(alias, 'utf8'), content, 'and so is the other name for the same file')
    }
  })
})

test('--out refuses to replace an existing file unless told to', async () => {
  await withBase(async (base) => {
    const input = join(base, 'input.csv')
    const output = join(base, 'profile.json')
    await writeFile(input, 'id,amount\n1,10\n')
    await writeFile(output, 'keep me')

    const refused = await run(['--input', input, '--out', output, '--out-root', base])
    assert.equal(refused.code, 2)
    assert.equal(refused.stdout, '')
    assert.match(refused.stderr, /already exists/)
    assert.equal(await readFile(output, 'utf8'), 'keep me')

    const allowed = await run(['--input', input, '--out', output, '--out-root', base, '--overwrite'])
    assert.equal(allowed.code, 0)
    assert.equal(JSON.parse(await readFile(output, 'utf8')).tool, 'csv-json-import-profiler')
  })
})

test('a profile that cannot be written to --out still reaches stdout, and the run exits 2', async () => {
  // The write is the side effect, not the answer: the report still goes to
  // stdout so a pipeline keeps its output, and the exit code says the run did
  // not do everything it was asked to. Without the failure this input exits 0,
  // so the exit code here is the write failure and nothing else.
  await withBase(async (base) => {
    const input = join(base, 'input.csv')
    await writeFile(input, 'id,amount\n1,10\n')
    const locked = join(base, 'locked')
    await mkdir(locked)
    await chmod(locked, 0o500)

    try {
      const { code, stdout, stderr } = await run([
        '--input', input,
        '--out', join(locked, 'profile.json'),
        '--out-root', base,
      ])
      assert.equal(code, 2)
      assert.match(stdout, /status pass/, 'the profile still reaches stdout')
      assert.match(stderr, /The profile could not be written to --out/)

      const clean = await run(['--input', input])
      assert.equal(clean.code, 0, 'the same input without --out exits 0, so the 2 above is the write failure')
    } finally {
      await chmod(locked, 0o700)
    }
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

test('a sibling directory whose name starts with the root is outside the root', async () => {
  // The classic confinement bypass: `/base/inbox-archive/x.csv` begins with the
  // string `/base/inbox`, so a prefix comparison without the separator lets it
  // through and the file is read and reported. The separator is what makes the
  // comparison about directories rather than about text.
  await withBase(async (base) => {
    const root = join(base, 'inbox')
    const sibling = join(base, 'inbox-archive')
    await mkdir(root)
    await mkdir(sibling)
    await writeFile(join(root, 'inside.csv'), 'id,name\n1,Ann\n')
    await writeFile(join(sibling, 'secret.csv'), 'id,name\n1,Zelda\n')

    const refused = await run(['--input', join(sibling, 'secret.csv'), '--root', root, '--json'])
    assert.equal(refused.code, 2)
    const report = JSON.parse(refused.stdout)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.findings.some((finding) => finding.ruleId === 'input-escapes-root'), true)
    assert.equal(report.summary.checked, 0, 'the refused file was not read')
    assert.equal(refused.stdout.includes('Zelda'), false, 'no content from outside the root reaches the report')
    assert.equal(refused.stdout.includes('secret.csv'), true, 'the refusal still names the file it refused')

    // The same run against a file genuinely inside the root succeeds, so the
    // refusal above is about containment and not about refusing everything.
    const allowed = await run(['--input', join(root, 'inside.csv'), '--root', root, '--json'])
    assert.equal(allowed.code, 0)
    assert.equal(JSON.parse(allowed.stdout).profile.file, 'inside.csv')
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
