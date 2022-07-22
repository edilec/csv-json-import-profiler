#!/usr/bin/env node

import { access, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { formatReport, profileFile } from '../src/index.mjs'

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

Exit codes:
  0  the input profiled cleanly
  1  the input was profiled and failed the check
  2  invalid usage or configuration (no report on stdout), or evidence that was
     missing, undecodable or bounded out (an "incomplete" report on stdout)
`

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
    } else throw new Error(`Unknown option "${argument}"`)
  }

  if (options.input === null) throw new Error('--input is required')
  return options
}

/**
 * Decide where a profile may be written.
 *
 * Two refusals, both about not destroying the subject of the run: the profile
 * never goes to the input itself, compared on real paths so a symlink cannot
 * launder one into the other, and it never replaces an existing file unless the
 * caller said so. A profiler that overwrote the export it was asked to describe
 * would be the worst possible bug in a tool like this.
 */
async function resolveOutput(outPath, inputPath, overwrite) {
  const target = resolve(outPath)
  const inputReal = await realpath(resolve(inputPath)).catch(() => null)
  const directory = await realpath(dirname(target)).catch(() => null)
  if (directory === null) throw new Error(`--out directory does not exist: ${dirname(outPath)}`)
  const targetReal = join(directory, basename(target))
  if (inputReal !== null && targetReal === inputReal) {
    throw new Error('--out must not be the input file; this tool never rewrites what it profiles')
  }
  const exists = await access(targetReal).then(() => true, () => false)
  if (exists && !overwrite) {
    throw new Error(`--out already exists: ${outPath} (pass --overwrite to replace it)`)
  }
  return targetReal
}

async function main(argv) {
  let options
  let outTarget = null
  try {
    options = parseArguments(argv)
    if (!options.help && options.out !== null) {
      outTarget = await resolveOutput(options.out, options.input, options.overwrite)
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
      process.stderr.write(`The profile could not be written to --out: ${error.code ?? error.message}\n`)
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
