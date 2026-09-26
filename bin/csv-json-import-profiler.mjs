#!/usr/bin/env node

import { lstat, writeFile } from 'node:fs/promises'

import { DestinationError, assertWritableDestination, excerpt, formatReport, profileFile } from '../src/index.mjs'

const HELP = `csv-json-import-profiler

Stream a bounded CSV or JSON input and report what an importer would find in it:
the type families each column holds, nulls, encoding, duplicate keys and records
whose shape drifts from the declared one.

Nothing is coerced: a column holding numbers and words is reported as mixed, not
rounded to the popular type. Nothing is rewritten: the input is opened read-only
and a profile goes to stdout or to --out. No value reaches the report -- samples
are a record number and a masked shape, because import data is where personal
data lives.

Usage:
  csv-json-import-profiler --input FILE [--format csv|json|jsonl] [--json]
                           [--out FILE] [--root DIR] [options] [limits]

Options:
  --input FILE            The file to profile (required)
  --root DIR              Report paths relative to this root, and refuse an
                          input that resolves outside it (default: the input's
                          own directory)
  --format NAME           csv, json (one top-level array) or jsonl (one record
                          per line). Default: inferred from the extension
  --delimiter CHAR        CSV delimiter, or comma, semicolon, tab, pipe
  --null-tokens A,B       Extra strings a file uses to mean "no value"
  --max-null-ratio N      Ratio of nulls a column may carry, 0 to 1 (default 0.5)
  --json                  Emit the machine-readable report on stdout
  --out FILE              Also write the JSON report to FILE. Never the input,
                          and never over an existing file without --overwrite
  --out-root DIR          Tree --out must resolve inside (default: the working
                          directory)
  --overwrite             Allow --out to replace an existing file
  -h, --help              Show this help

Limits (exceeding one is a finding and an incomplete report, never a silent cut):
  --max-input-bytes N     Bytes read from the input (default 8388608)
  --max-records N         Records profiled (default 10000)
  --max-row-bytes N       Bytes in one record (default 65536)
  --max-columns N         Columns (default 256)
  --max-depth N           JSON nesting depth per record (default 16)
  --max-findings N        Findings collected (default 1000)
  --max-millis N          Milliseconds of profiling, 0 for none (default 10000)

Every option that carries a value may be given only once: a repeated flag is a
configuration error, not a silent last-wins. An unknown option is refused, so a
one-character typo cannot quietly turn a real failure into a green run.

--out is checked before the input is opened. A symbolic link at the destination,
a symlinked directory on the way to it, a path that resolves outside --out-root
and a hard link to the input are each refused: every one of them writes the
profile over a file this tool was never asked to touch.

Exit codes:
  0  the input profiled cleanly
  1  the input was profiled and failed the check
  2  invalid usage or configuration (no report on stdout), or evidence that was
     missing, undecodable or bounded out (an "incomplete" report on stdout)
`

/**
 * A value from argv, bounded and stripped of anything that forges a line.
 *
 * An argument is as untrusted as the file it names: paths arrive from directory
 * listings, CI variables and globs. ESC opens a terminal escape sequence and
 * U+2028 is a line break to a great many readers, so a diagnostic that quoted
 * either back verbatim could be made to read as something else -- the same
 * forgery the report path already refuses to let the input's bytes commit.
 */
const quote = (value) => excerpt(String(value), 200)

const LIMIT_FLAGS = new Map([
  ['--max-columns', 'maxColumns'],
  ['--max-depth', 'maxDepth'],
  ['--max-findings', 'maxFindings'],
  ['--max-input-bytes', 'maxInputBytes'],
  ['--max-millis', 'maxMillis'],
  ['--max-records', 'maxRecords'],
  ['--max-row-bytes', 'maxRowBytes'],
])

const DELIMITER_NAMES = new Map([
  ['comma', ','],
  ['pipe', '|'],
  ['semicolon', ';'],
  ['tab', '\t'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = {
    input: null,
    root: null,
    format: null,
    delimiter: null,
    nullTokens: null,
    nullRatio: null,
    out: null,
    outRoot: null,
    overwrite: false,
    json: false,
    limits: {},
  }
  const given = new Set()

  /**
   * A flag that carries a value is accepted once.
   *
   * Letting it repeat discards the earlier value with no diagnostic, so
   * `--input a --input b` profiles a file nobody named and
   * `--max-records 5 --max-records 1` enforces a limit nobody asked for. That
   * is the same defect as an ignored typo, which this tool already refuses.
   */
  const once = (name) => {
    if (given.has(name)) throw new Error(`${name} was given more than once`)
    given.add(name)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') options.json = true
    else if (argument === '--overwrite') options.overwrite = true
    else if (argument === '--input') {
      once('--input')
      options.input = takeValue('--input')
    } else if (argument === '--root') {
      once('--root')
      options.root = takeValue('--root')
    } else if (argument === '--out') {
      once('--out')
      options.out = takeValue('--out')
    } else if (argument === '--out-root') {
      once('--out-root')
      options.outRoot = takeValue('--out-root')
    } else if (argument === '--format') {
      once('--format')
      options.format = takeValue('--format')
    } else if (argument === '--delimiter') {
      once('--delimiter')
      const raw = takeValue('--delimiter')
      options.delimiter = DELIMITER_NAMES.get(raw) ?? raw
    } else if (argument === '--null-tokens') {
      once('--null-tokens')
      options.nullTokens = takeValue('--null-tokens').split(',')
    } else if (argument === '--max-null-ratio') {
      once('--max-null-ratio')
      const raw = takeValue('--max-null-ratio')
      if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(raw)) {
        throw new Error('--max-null-ratio requires a number between 0 and 1')
      }
      options.nullRatio = Number(raw)
    } else if (LIMIT_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      const floor = argument === '--max-millis' ? 0 : 1
      if (!/^\d+$/.test(raw) || Number(raw) < floor) {
        throw new Error(`${argument} requires an integer of at least ${floor}`)
      }
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    } else throw new Error(`Unknown option "${quote(argument)}"`)
  }

  if (options.input === null) throw new Error('--input is required')
  if (options.outRoot !== null && options.out === null) {
    throw new Error('--out-root has no meaning without --out')
  }
  if (options.overwrite && options.out === null) {
    throw new Error('--overwrite has no meaning without --out')
  }
  return options
}

/**
 * Decide where a profile may be written.
 *
 * The first version of this function resolved the destination and compared the
 * result with the input. That caught a symbolic link pointing AT the input and
 * a hard link to it, and missed the case that actually destroys files: a
 * symbolic link pointing anywhere else. `realpath` resolved it, the resolved
 * path was not the input, and `writeFile` went through the link. Measured
 * here, with `--overwrite`: a 9-byte file outside the tree became a 3460-byte
 * profile at exit 0. Without an existing target to resolve -- a link whose
 * target does not exist yet -- the profile was created out there instead, and
 * `--overwrite` was not even needed. A symlinked parent directory did the same
 * thing one level up.
 *
 * `assertWritableDestination` carries the reasoning for all three holes, and
 * the identity comparison that answers the hard link lives inside it now: the
 * inode is the only thing two names for one file share.
 *
 * `--overwrite` is a separate question and is asked afterwards. The guard has
 * already established that the destination is the file the caller named; this
 * refuses replacing a file the caller named but did not mean to lose.
 */
async function resolveOutput(outPath, inputPath, overwrite, outRoot) {
  let target
  try {
    target = await assertWritableDestination(outPath, {
      inputs: [inputPath],
      root: outRoot,
      label: '--out',
      rootLabel: '--out-root',
    })
  } catch (error) {
    if (!(error instanceof DestinationError)) throw error
    throw new Error(error.message)
  }
  const exists = await lstat(target).then(() => true, () => false)
  if (exists && !overwrite) {
    throw new Error(`--out already exists: ${quote(outPath)} (pass --overwrite to replace it)`)
  }
  return target
}

async function main(argv) {
  let options
  let outTarget = null
  try {
    options = parseArguments(argv)
    if (!options.help && options.out !== null) {
      outTarget = await resolveOutput(
        options.out,
        options.input,
        options.overwrite,
        options.outRoot ?? process.cwd(),
      )
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }

  let report
  try {
    report = await profileFile({
      input: options.input,
      limits: options.limits,
      ...(options.root === null ? {} : { root: options.root }),
      ...(options.format === null ? {} : { format: options.format }),
      ...(options.delimiter === null ? {} : { delimiter: options.delimiter }),
      ...(options.nullTokens === null ? {} : { nullTokens: options.nullTokens }),
      ...(options.nullRatio === null ? {} : { nullRatio: options.nullRatio }),
    })
  } catch (error) {
    // Configuration never had a subject, so stdout stays empty.
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  const json = `${JSON.stringify(report, null, 2)}\n`
  let writeFailed = false
  if (outTarget !== null) {
    try {
      await writeFile(outTarget, json)
    } catch (error) {
      writeFailed = true
      process.stderr.write(`The profile could not be written to --out: ${quote(error.code ?? error.message)}\n`)
    }
  }

  process.stdout.write(options.json ? json : formatReport(report))

  if (writeFailed) return 2
  if (report.status === 'incomplete') {
    const { checked, records, skipped } = report.summary
    process.stderr.write(
      `incomplete: ${checked} of ${records} record(s) found were profiled and ${skipped} were not. ` +
      'The findings say what was not examined. Unknown is not a pass.\n',
    )
    return 2
  }
  return report.status === 'fail' ? 1 : 0
}

process.exitCode = await main(process.argv.slice(2))
