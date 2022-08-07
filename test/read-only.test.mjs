import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { profileFile } from '../src/index.mjs'

const execute = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/csv-json-import-profiler.mjs')

/**
 * The input is never rewritten.
 *
 * The acceptance requirement says "input is never rewritten implicitly", and
 * the honest test of that is not a grep: it is reading the bytes and the
 * modification time before and after a run and finding them unchanged --
 * including on the runs most likely to tempt a tool into fixing something,
 * which are the broken ones.
 */

async function withBase(body) {
  const base = await mkdtemp(join(tmpdir(), 'csv-json-import-profiler-readonly-'))
  try {
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

async function fingerprint(path) {
  const [bytes, info] = await Promise.all([readFile(path), stat(path)])
  return { bytes: bytes.toString('base64'), size: info.size, modified: info.mtimeMs }
}

async function run(args) {
  try {
    const { stdout } = await execute(process.execPath, [CLI, ...args], { cwd: projectDirectory })
    return { code: 0, stdout }
  } catch (error) {
    return { code: error.code, stdout: error.stdout }
  }
}

const INPUTS = [
  ['a clean CSV', 'orders.csv', 'order_id,amount\n1001,10.50\n1002,4.00\n'],
  ['a CSV with a mixed column and a drifted row', 'broken.csv', 'id,amount\n1,10\n2,text\n3,1,stray\n'],
  ['a CSV with an unterminated quote', 'unclosed.csv', 'id,note\n1,ok\n2,"never closed\n'],
  ['a JSON array with a repeated key', 'catalog.json', '[{"sku":"A","sku":"B"}]'],
  ['a JSON file that is not an array', 'wrapped.json', '{"rows":[{"a":1}]}'],
  ['NDJSON with a record that does not parse', 'events.jsonl', '{"a":1}\n{oops}\n{"a":2}\n'],
]

for (const [label, name, content] of INPUTS) {
  test(`${label} is byte-identical after the library profiles it`, async () => {
    await withBase(async (base) => {
      const target = join(base, name)
      await writeFile(target, content)
      const before = await fingerprint(target)

      const report = await profileFile({ input: target })
      assert.ok(['pass', 'fail', 'incomplete'].includes(report.status))

      assert.deepEqual(await fingerprint(target), before, 'the input changed during a profile run')
      assert.equal(await readFile(target, 'utf8'), content)
    })
  })

  test(`${label} is byte-identical after the binary profiles it to --out`, async () => {
    await withBase(async (base) => {
      const target = join(base, name)
      await writeFile(target, content)
      const before = await fingerprint(target)

      const { code } = await run(['--input', target, '--out', join(base, 'profile.json'), '--json'])
      assert.ok([0, 1, 2].includes(code))

      assert.deepEqual(await fingerprint(target), before, 'the input changed during a profile run')
      // The profile went somewhere else entirely.
      assert.equal(JSON.parse(await readFile(join(base, 'profile.json'), 'utf8')).tool, 'csv-json-import-profiler')
    })
  })
}

test('nothing else appears beside the input either', async () => {
  await withBase(async (base) => {
    const target = join(base, 'orders.csv')
    await writeFile(target, 'id,amount\n1,10\n2,text\n')

    await profileFile({ input: target })
    await run(['--input', target])
    await run(['--input', target, '--json'])

    assert.deepEqual(await readdir(base), ['orders.csv'], 'a profile run left something behind')
  })
})

test('the example inputs shipped with this package are unchanged by npm run example', async () => {
  const names = await readdir(join(projectDirectory, 'examples'))
  const before = {}
  for (const name of names) before[name] = await fingerprint(join(projectDirectory, 'examples', name))

  for (const name of names) await run(['--input', join('examples', name)])

  for (const name of names) {
    assert.deepEqual(await fingerprint(join(projectDirectory, 'examples', name)), before[name], `${name} changed`)
  }
})

/**
 * A secondary check. The byte comparisons above are the guarantee; this one
 * says where a write could ever come from, and keeps the answer to "only the
 * binary, only to --out" true.
 */
test('the library has no write path at all', async () => {
  // Two questions, because either alone is answerable by accident: what does
  // src import from the filesystem, and does any line of it call a writer?
  const readOnly = new Set(['createReadStream', 'realpath', 'stat'])
  const writers = [
    'writeFile(',
    'writeFileSync(',
    'createWriteStream(',
    'appendFile(',
    'truncate(',
    'unlink(',
    'rename(',
    'rmdir(',
    'mkdir(',
    'chmod(',
    'utimes(',
  ]

  for (const name of await readdir(join(projectDirectory, 'src'))) {
    const source = await readFile(join(projectDirectory, 'src', name), 'utf8')
    const code = source
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim()
        return !(trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//'))
      })
      .join('\n')

    for (const match of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*'node:fs(?:\/promises)?'/g)) {
      for (const imported of match[1].split(',').map((part) => part.trim()).filter(Boolean)) {
        assert.ok(readOnly.has(imported), `src/${name} imports ${imported} from the filesystem`)
      }
    }
    for (const writer of writers) {
      assert.equal(code.includes(writer), false, `src/${name} reaches for ${writer}`)
    }
  }

  // The binary writes, and only where --out points.
  const binary = await readFile(CLI, 'utf8')
  assert.equal((binary.match(/writeFile\(/g) ?? []).length, 1)
  assert.match(binary, /await writeFile\(outTarget, json\)/)
})
