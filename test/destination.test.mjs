/**
 * The output destination, one test per hole and one per allowed shape.
 *
 * Three of these were measured destroying or creating real files through the
 * real CLI before the guard went in. The symlink cases are the ones the
 * previous design could not see, because `--out already exists` refused them
 * for the wrong reason and `--overwrite` -- the flag whose whole purpose is to
 * say "yes, replace that file" -- lifted the refusal:
 *
 *   symlink at --out, --overwrite   9-byte file outside the tree -> 3460-byte
 *                                   profile, exit 0
 *   dangling symlink at --out       profile created outside the tree, exit 0,
 *                                   no --overwrite needed
 *   symlinked parent, --overwrite   same destruction, one level up
 *
 * The allowed cases are not decoration. A guard that refuses everything passes
 * every data-loss test while making the tool useless, so the shapes that must
 * still work are pinned in the same file as the shapes that must not.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/csv-json-import-profiler.mjs')

const PRECIOUS = 'keep me\n'
const INPUT_CSV = 'id,amount\n1,10\n2,20\n'

async function run(args) {
  try {
    const { stdout, stderr } = await execute(process.execPath, [CLI, ...args], { cwd: projectDirectory })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

/** A temporary tree: an input, a permitted output root, and a directory outside it. */
async function withBase(body) {
  const base = await mkdtemp(join(tmpdir(), 'csv-json-import-profiler-destination-'))
  try {
    const input = join(base, 'input.csv')
    const permitted = join(base, 'permitted')
    const elsewhere = join(base, 'elsewhere')
    await writeFile(input, INPUT_CSV)
    await mkdir(permitted)
    await mkdir(elsewhere)
    await writeFile(join(elsewhere, 'precious.json'), PRECIOUS)
    return await body({ base, input, permitted, elsewhere, precious: join(elsewhere, 'precious.json') })
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

async function exists(path) {
  return stat(path).then(() => true, () => false)
}

/**
 * The refusal itself, not the help text printed under it.
 *
 * A configuration error prints the message and then the whole `--help` output,
 * which describes the destination policy in prose -- so a test that matched
 * /symbolic link/ against the entire stream passed whether or not the symlink
 * check existed. Mutation testing found exactly that: deleting the symlink
 * refusal left all fourteen of these tests green, because the phrase they were
 * matching was in the help. Assert against the first line, which is the tool's
 * answer about this run.
 */
function reason(stderr) {
  return String(stderr).split('\n')[0]
}

// ---------------------------------------------------------------------------
// Hole 1: a symbolic link at the destination.
// ---------------------------------------------------------------------------

test('a symlink at --out is refused, and the file it points at survives', async () => {
  await withBase(async ({ input, permitted, precious }) => {
    const destination = join(permitted, 'profile.json')
    await symlink(precious, destination)

    // --overwrite is the dangerous combination. Without it the run stopped
    // because "the destination exists", which hid the destruction rather than
    // preventing it; with it, the file outside the tree was destroyed.
    const result = await run(['--input', input, '--out', destination, '--out-root', permitted, '--overwrite'])

    assert.equal(result.code, 2)
    assert.equal(result.stdout, '', 'a refused destination is a configuration error, so stdout stays empty')
    assert.match(reason(result.stderr), /symbolic link/)
    assert.equal(await readFile(precious, 'utf8'), PRECIOUS)
  })
})

test('a symlink at --out is refused without --overwrite too, and for the right reason', async () => {
  await withBase(async ({ input, permitted, precious }) => {
    const destination = join(permitted, 'profile.json')
    await symlink(precious, destination)

    const result = await run(['--input', input, '--out', destination, '--out-root', permitted])

    assert.equal(result.code, 2)
    assert.match(reason(result.stderr), /symbolic link/, 'not "already exists", which is a refusal for the wrong reason')
    assert.equal(await readFile(precious, 'utf8'), PRECIOUS)
  })
})

test('a symlink at --out whose target does not exist yet creates nothing', async () => {
  // This one needed no --overwrite at all: `realpath` fails on a dangling
  // link, so the destination looked absent, and the write followed the link
  // and created the profile outside the tree the caller named.
  await withBase(async ({ input, permitted, elsewhere }) => {
    const wouldBeCreated = join(elsewhere, 'created.json')
    const destination = join(permitted, 'profile.json')
    await symlink(wouldBeCreated, destination)

    const result = await run(['--input', input, '--out', destination, '--out-root', permitted])

    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(reason(result.stderr), /symbolic link/)
    assert.equal(await exists(wouldBeCreated), false, 'the profile was created outside the root')
  })
})

// ---------------------------------------------------------------------------
// Hole 2: a symlinked parent directory.
// ---------------------------------------------------------------------------

test('a symlinked parent directory cannot carry the profile out of --out-root', async () => {
  await withBase(async ({ input, permitted, elsewhere, precious }) => {
    // Lexically `permitted/link/precious.json` is inside --out-root. It is not.
    await symlink(elsewhere, join(permitted, 'link'))

    const result = await run([
      '--input', input,
      '--out', join(permitted, 'link', 'precious.json'),
      '--out-root', permitted,
      '--overwrite',
    ])

    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(reason(result.stderr), /outside the permitted root/)
    assert.equal(await readFile(precious, 'utf8'), PRECIOUS)
  })
})

test('a lexical ".." segment cannot carry the profile out of --out-root', async () => {
  await withBase(async ({ input, permitted, precious }) => {
    const result = await run([
      '--input', input,
      '--out', join(permitted, '..', 'elsewhere', 'precious.json'),
      '--out-root', permitted,
      '--overwrite',
    ])

    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(reason(result.stderr), /outside the permitted root/)
    assert.equal(await readFile(precious, 'utf8'), PRECIOUS)
  })
})

// ---------------------------------------------------------------------------
// Hole 3: a hard link to the input.
// ---------------------------------------------------------------------------

test('a hard link to the input is refused, and the input survives', async () => {
  await withBase(async ({ input, permitted }) => {
    const destination = join(permitted, 'profile.json')
    await link(input, destination)

    const result = await run(['--input', input, '--out', destination, '--out-root', permitted, '--overwrite'])

    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(reason(result.stderr), /same file as an input/)
    assert.equal(await readFile(input, 'utf8'), INPUT_CSV)
  })
})

// ---------------------------------------------------------------------------
// Shapes that cannot be written at all.
// ---------------------------------------------------------------------------

test('a destination that is a directory is refused', async () => {
  await withBase(async ({ input, permitted }) => {
    const folder = join(permitted, 'folder')
    await mkdir(folder)

    const result = await run(['--input', input, '--out', folder, '--out-root', permitted, '--overwrite'])

    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(reason(result.stderr), /not a regular file/)
  })
})

test('a destination whose directory does not exist is refused rather than created', async () => {
  await withBase(async ({ input, permitted }) => {
    const result = await run([
      '--input', input,
      '--out', join(permitted, 'absent', 'profile.json'),
      '--out-root', permitted,
    ])

    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(reason(result.stderr), /directory that does not exist/)
    assert.equal(await exists(join(permitted, 'absent')), false)
  })
})

// ---------------------------------------------------------------------------
// The allowed cases. A guard that refuses these is a guard that broke the tool.
// ---------------------------------------------------------------------------

test('an ordinary destination inside --out-root is written', async () => {
  await withBase(async ({ input, permitted }) => {
    const destination = join(permitted, 'profile.json')

    const result = await run(['--input', input, '--out', destination, '--out-root', permitted])

    assert.equal(result.code, 0)
    const written = JSON.parse(await readFile(destination, 'utf8'))
    assert.equal(written.tool, 'csv-json-import-profiler')
    assert.equal(written.summary.checked, 2)
  })
})

test('a destination in a subdirectory of --out-root is written', async () => {
  await withBase(async ({ input, permitted }) => {
    await mkdir(join(permitted, 'nested'))
    const destination = join(permitted, 'nested', 'profile.json')

    const result = await run(['--input', input, '--out', destination, '--out-root', permitted])

    assert.equal(result.code, 0)
    assert.equal(JSON.parse(await readFile(destination, 'utf8')).summary.checked, 2)
  })
})

test('an existing ordinary file inside --out-root is replaced with --overwrite, and kept without it', async () => {
  await withBase(async ({ input, permitted }) => {
    const destination = join(permitted, 'profile.json')
    await writeFile(destination, PRECIOUS)

    const refused = await run(['--input', input, '--out', destination, '--out-root', permitted])
    assert.equal(refused.code, 2)
    assert.match(reason(refused.stderr), /already exists/)
    assert.equal(await readFile(destination, 'utf8'), PRECIOUS)

    const allowed = await run(['--input', input, '--out', destination, '--out-root', permitted, '--overwrite'])
    assert.equal(allowed.code, 0)
    assert.equal(JSON.parse(await readFile(destination, 'utf8')).tool, 'csv-json-import-profiler')
  })
})

test('an --out-root reached through a symlinked ancestor still accepts its own files', async () => {
  // The mirror image of hole 2, and the reason the comparison is real path
  // against real path in both directions. On macOS the system temporary
  // directory is itself reached through a symlink, so a guard that compares a
  // resolved destination with an unresolved root refuses every legitimate
  // destination on the machine it is running on.
  await withBase(async ({ base, input, permitted }) => {
    const alias = join(base, 'alias')
    await symlink(permitted, alias)

    const result = await run(['--input', input, '--out', join(alias, 'profile.json'), '--out-root', alias])

    assert.equal(result.code, 0)
    assert.equal(JSON.parse(await readFile(join(permitted, 'profile.json'), 'utf8')).summary.checked, 2)
  })
})

test('--out-root defaults to the working directory, and a destination outside it is refused', async () => {
  await withBase(async ({ input, permitted }) => {
    const result = await run(['--input', input, '--out', join(permitted, 'profile.json')])

    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(reason(result.stderr), /outside the permitted root/)
    assert.equal(await exists(join(permitted, 'profile.json')), false)
  })
})

test('--out-root and --overwrite have no meaning without --out', async () => {
  await withBase(async ({ input, permitted }) => {
    const withoutOut = await run(['--input', input, '--out-root', permitted])
    assert.equal(withoutOut.code, 2)
    assert.equal(withoutOut.stdout, '')
    assert.match(reason(withoutOut.stderr), /--out-root has no meaning without --out/)

    const overwrite = await run(['--input', input, '--overwrite'])
    assert.equal(overwrite.code, 2)
    assert.equal(overwrite.stdout, '')
    assert.match(reason(overwrite.stderr), /--overwrite has no meaning without --out/)
  })
})
