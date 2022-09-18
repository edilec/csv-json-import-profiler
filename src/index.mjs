/**
 * csv-json-import-profiler
 *
 * Streams a bounded CSV or JSON input and reports what an importer would find
 * in it: the type families each column actually holds, how much of it is null,
 * which records drift from the declared shape, which object keys are set twice,
 * and what the file's encoding and line endings are.
 *
 * Four properties are structural rather than incidental:
 *
 * 1. **Nothing is coerced.** A column holding `42` and `forty-two` is reported
 *    as mixed. A profiler that picked the popular type would describe a file
 *    nobody has, and the mixed column is the whole finding.
 * 2. **Nothing is rewritten.** The input is opened read-only. There is no
 *    auto-fix, no normalisation pass and no in-place write anywhere in `src/`;
 *    a profile goes to a separate destination or to stdout.
 * 3. **No value reaches the report.** Import data is where personal data lives,
 *    so samples are redacted references: a record number and a masked shape.
 *    `alice@example.com` is reported as `aaaaa@aaaaaaa.aaa`.
 * 4. **Unknown is never a pass.** A record that could not be decoded, parsed or
 *    read inside the declared limits makes the run `incomplete`. The tool
 *    reports what it did not see rather than reporting silence as health.
 */

import { Buffer } from 'node:buffer'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, relative, resolve, sep } from 'node:path'

import { CsvReader, DEFAULT_DELIMITER, validateDelimiter } from './csv.mjs'
import { JsonRecordReader } from './json.mjs'
import { Profiler, createFinding, sortFindings } from './profile.mjs'
import { createUtf8Decoder, excerpt, hasBom, sanitize } from './text.mjs'

export const TOOL_ID = 'csv-json-import-profiler'
export const REPORT_SCHEMA_VERSION = '1'

/**
 * Bounds are part of the contract, not a safety net.
 *
 * An import file is ordinary untrusted input: it can be a 4 GB export, a single
 * record with an unclosed quote that swallows the rest of the file, or a
 * structure nested deeply enough to exhaust a parser. Every limit below is
 * explicit, overridable from the CLI, and named in a finding when it is hit.
 * Exceeding one produces an `incomplete` report -- never a quietly shorter
 * answer, and never a pass.
 *
 * `maxMillis` is the one limit that may be zero. The budget is spent once the
 * elapsed time reaches it, so zero is spent before the first record -- which is
 * how the wiring between the CLI flag and the clock is proven rather than
 * assumed.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxColumns: 256,
  maxDepth: 16,
  maxFindings: 1000,
  maxInputBytes: 8388608,
  maxMillis: 10000,
  maxRecords: 10000,
  maxRowBytes: 65536,
})

const ZERO_ALLOWED_LIMITS = Object.freeze(['maxMillis'])

export const FORMATS = Object.freeze(['csv', 'json', 'jsonl'])

/** Extensions this tool will infer a format from. Anything else must be declared. */
export const FORMAT_BY_EXTENSION = Object.freeze({
  '.csv': 'csv',
  '.json': 'json',
  '.jsonl': 'jsonl',
  '.ndjson': 'jsonl',
  '.tsv': 'csv',
})

export const DEFAULT_NULL_RATIO = 0.5
const MAX_NULL_TOKENS = 32

const FILE_OPTIONS = Object.freeze([
  'clock',
  'delimiter',
  'format',
  'input',
  'limits',
  'nullRatio',
  'nullTokens',
  'root',
])
const TEXT_OPTIONS = Object.freeze([
  'clock',
  'delimiter',
  'file',
  'format',
  'limits',
  'nullRatio',
  'nullTokens',
])

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function rejectUnknownOptions(options, allowed) {
  if (!isRecord(options)) throw new TypeError('Options must be an object')
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) throw new TypeError(`Unknown option "${key}"`)
  }
}

/**
 * Only an absent `limits` means "use the defaults".
 *
 * `null` is a value the caller computed and lost, not an omission, and
 * accepting it as `{}` is the same silent ignore this tool refuses everywhere
 * else: an unknown limit name and a fractional limit are both errors, so a
 * limits object that turned out to be null cannot be the one thing waved
 * through. A misspelled limit must not quietly leave the default in place.
 */
export function validateLimits(overrides = {}) {
  if (!isRecord(overrides)) throw new TypeError('Limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const [name, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, name)) throw new TypeError(`Unknown limit "${name}"`)
    const floor = ZERO_ALLOWED_LIMITS.includes(name) ? 0 : 1
    if (!Number.isInteger(value) || value < floor) {
      throw new TypeError(`Limit "${name}" must be an integer of at least ${floor}`)
    }
    limits[name] = value
  }
  return Object.freeze(limits)
}

/** The format, declared or inferred from the extension. Never guessed from content. */
export function validateFormat(format, path) {
  if (format !== undefined && format !== 'auto') {
    if (!FORMATS.includes(format)) throw new TypeError(`Unknown format "${sanitize(String(format))}"`)
    return format
  }
  const extension = path === undefined ? '' : extname(path).toLowerCase()
  const inferred = Object.hasOwn(FORMAT_BY_EXTENSION, extension) ? FORMAT_BY_EXTENSION[extension] : undefined
  if (inferred === undefined) {
    throw new TypeError(
      `Cannot infer a format from "${sanitize(String(extension === '' ? path ?? '' : extension))}"; pass --format csv, json or jsonl`,
    )
  }
  return inferred
}

/**
 * Tokens a file uses to write "no value".
 *
 * Validated rather than accepted: a token carrying a control character or a
 * U+FFFD did not survive the journey from the shell intact, and matching
 * against it would silently never match. That is the ignored-configuration
 * defect in miniature.
 */
export function validateNullTokens(tokens = []) {
  if (!Array.isArray(tokens)) throw new TypeError('Null tokens must be an array of strings')
  if (tokens.length > MAX_NULL_TOKENS) throw new TypeError(`At most ${MAX_NULL_TOKENS} null tokens may be configured`)
  for (const token of tokens) {
    if (typeof token !== 'string') throw new TypeError('Null tokens must be an array of strings')
    if (token !== sanitize(token)) throw new TypeError('A null token must not contain control characters')
    if (token.includes('\uFFFD')) {
      throw new TypeError('A null token arrived as U+FFFD, so it was not the token you typed')
    }
  }
  return Object.freeze([...tokens])
}

export function validateNullRatio(value) {
  if (value === undefined) return DEFAULT_NULL_RATIO
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError('Null ratio must be a number between 0 and 1')
  }
  return value
}

function validateClock(clock) {
  if (clock === undefined) return () => performance.now()
  if (typeof clock !== 'function') throw new TypeError('Clock must be a function returning milliseconds')
  return clock
}

/**
 * Containment, decided on real paths.
 *
 * Refusing `../` and absolute strings is not confinement: a symbolic link
 * planted inside the declared root resolves out of the tree without ever
 * spelling a traversal. Both sides of this comparison have been through
 * `realpath` before they arrive -- comparing a real root against a path that
 * was not resolved is the over-correction, and it refuses files that genuinely
 * are inside a root reached through a symlink. A false refusal is a bug too.
 */
export function isInside(root, candidate) {
  if (candidate === root) return true
  return candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

function buildReport(profiler, extra) {
  const findings = sortFindings(profiler.rows).map(createFinding)
  const errors = findings.filter((finding) => finding.severity === 'error').length
  const warnings = findings.filter((finding) => finding.severity === 'warning').length
  const status = profiler.incomplete ? 'incomplete' : errors > 0 ? 'fail' : 'pass'
  const counts = profiler.counts

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: {
      checked: counts.checked,
      errors,
      warnings,
      info: findings.length - errors - warnings,
      records: counts.records,
      profiled: counts.profiled,
      skipped: counts.skipped,
      columns: profiler.columns.length,
      driftedRecords: counts.drifted,
      duplicateKeys: counts.duplicateKeys,
      nulls: counts.nulls,
      bytes: extra.bytes,
    },
    profile: profiler.profile(),
    findings,
  }
}

/**
 * Profile a byte stream.
 *
 * The core of the tool: bytes in, report out, with the whole stream bounded.
 * Nothing here reads the clock except through the injected `clock`, and the
 * elapsed time never reaches the output -- it can only end the run early, which
 * is a finding of its own.
 */
async function profileSource(source, settings) {
  const { file, format, limits, delimiter, nullTokens, nullRatio, clock } = settings
  const profiler = new Profiler({ file, format, nullTokens, nullRatio, limits })
  const decoder = createUtf8Decoder()
  const reader =
    format === 'csv'
      ? new CsvReader({ delimiter, maxRecordChars: limits.maxRowBytes })
      : new JsonRecordReader({ mode: format === 'jsonl' ? 'lines' : 'array', maxRecordChars: limits.maxRowBytes })

  const started = clock()
  let bytes = 0
  let ordinal = 0
  let headerRead = false
  let sniffed = false
  let head = null
  let failed = false

  /**
   * Decode strictly, or end the run saying the bytes were refused.
   *
   * The decoder's own failure is caught here rather than in the outer handler,
   * so that a `TypeError` thrown by a bug in this tool cannot be reported as
   * "your file is not UTF-8". A run must not explain its own defects as a
   * property of the input.
   */
  const decode = (chunk, final = false) => {
    try {
      return final ? decoder.end() : decoder.push(chunk)
    } catch {
      profiler.stop(
        'input-not-utf8',
        `The input is not valid UTF-8 within the first ${bytes} byte(s), so it was refused by the decoder rather than guessed at. Nothing after the offending byte was read.`,
        { suggestion: 'Re-export as UTF-8. A profile of mis-decoded bytes would describe a file nobody has.' },
      )
      return null
    }
  }

  /**
   * The time budget is spent once the elapsed time reaches it, not once it
   * passes it, which is what makes a budget of zero mean zero. Nothing about
   * the elapsed time reaches the report: a clock can only end the run early,
   * and that is a finding of its own.
   */
  const outOfTime = () => {
    if (clock() - started < limits.maxMillis) return false
    profiler.stop(
      'time-limit-exceeded',
      `Profiling passed the maxMillis limit of ${limits.maxMillis} after ${profiler.counts.records} record(s). The rest of the input was not read.`,
      { suggestion: 'Raise --max-millis, or profile a smaller slice of the input.' },
    )
    return true
  }

  const handle = (records) => {
    for (const record of records) {
      if (profiler.stopped) return
      if (format === 'csv' && !headerRead) {
        headerRead = true
        profiler.readHeader(record)
        if (profiler.stopped) return
        continue
      }
      ordinal += 1
      profiler.counts.records += 1
      if (profiler.recordsExhausted()) return
      if (format === 'csv') profiler.readCsvRecord(record, ordinal)
      else profiler.readJsonRecord(record, ordinal)
      if (outOfTime()) return
    }
  }

  try {
    for await (const chunk of source) {
      if (profiler.stopped) break
      bytes += chunk.length
      if (bytes > limits.maxInputBytes) {
        profiler.stop(
          'input-too-large',
          `The input passed the maxInputBytes limit of ${limits.maxInputBytes} after ${bytes} byte(s). It was not read to the end, so this profile is partial.`,
          { suggestion: 'Raise --max-input-bytes, or split the export into smaller files.' },
        )
        break
      }
      if (!sniffed) {
        head = head === null ? chunk : Buffer.concat([Buffer.from(head), Buffer.from(chunk)])
        if (head.length < 3) continue
        sniffed = true
        if (hasBom(head)) {
          profiler.noteInput(
            'input-has-bom',
            'The input starts with a UTF-8 byte order mark. Importers that do not strip it read the first column name with an invisible character in front of it.',
            { suggestion: 'Export without a BOM, or strip it before importing.' },
          )
        }
        const decoded = decode(head)
        head = null
        if (decoded === null) break
        handle(reader.push(decoded))
        continue
      }
      const decoded = decode(chunk)
      if (decoded === null) break
      handle(reader.push(decoded))
      if (outOfTime()) break
    }

    if (!profiler.stopped && !sniffed) {
      // A file shorter than a byte order mark still has to be read.
      sniffed = true
      if (head !== null) {
        const decoded = decode(head)
        if (decoded !== null) handle(reader.push(decoded))
      }
    }

    if (!profiler.stopped) {
      // The flush is where a file that stops mid-character is caught.
      const decoded = decode(null, true)
      if (decoded !== null) handle(reader.push(decoded))
    }
  } catch (error) {
    failed = true
    profiler.incomplete = true
    profiler.noteInput('input-unreadable', `The input could not be read: ${error.code ?? error.message}`, {
      suggestion: 'Check the path and its permissions.',
    })
  }

  if (!failed && !profiler.stopped) {
    const tail = reader.end()
    handle(tail.records ?? [])
    if (format === 'csv' && tail.unterminated) {
      profiler.incomplete = true
      profiler.noteInput(
        'unterminated-quoted-field',
        `A quoted field opened at line ${tail.line} is never closed, so the rest of the input is one unterminated record and its shape is unknown.`,
        { suggestion: 'Close the quote, or double an embedded quote that was meant literally.' },
      )
    }
    if (format !== 'csv' && tail.error !== null && tail.error !== undefined) {
      profiler.incomplete = true
      const detail =
        tail.error.kind === 'not-array'
          ? 'the top-level value is not a JSON array'
          : tail.error.kind === 'trailing-content'
            ? 'content follows the top-level array'
            : 'the top-level array is never closed'
      profiler.noteInput(
        'input-not-an-array',
        `This input was read as a JSON record array and ${detail} (line ${tail.error.line}). No record after that point was profiled.`,
        { suggestion: 'Pass --format jsonl for one record per line, or wrap the records in a single top-level array.' },
      )
    }
  }

  if (format === 'csv') {
    const { cr, crlf, lf } = reader.endings
    const kinds = [cr > 0, crlf > 0, lf > 0].filter(Boolean).length
    if (kinds > 1) {
      profiler.noteInput(
        'input-mixed-line-endings',
        `The input mixes line endings (${crlf} CRLF, ${lf} LF, ${cr} CR). Readers that split on one of them will produce records the others would not.`,
        { suggestion: 'Normalise the export to one line ending.' },
      )
    }
  }

  return finalize(profiler, bytes)
}

/**
 * Close a run: evaluate the column rules, then refuse to be green on nothing.
 *
 * A run that profiled no record checked nothing, so it says so and is
 * incomplete: `pass` with `checked: 0` is not reachable from here. The test is
 * `checked`, the field the guarantee is written in terms of, and not `records`,
 * because an input whose every record a limit refused found records and
 * examined none of them.
 *
 * Every path that produces a report ends here -- the streamed one, the
 * unreadable one and the refused one -- so none of them can acquire a different
 * idea of what an empty run means.
 */
function finalize(profiler, bytes) {
  profiler.finish()
  if (profiler.counts.checked === 0) {
    profiler.noteInput(
      'no-records-profiled',
      `No record was profiled, so this run checked nothing. ${profiler.counts.records} record(s) were found and ${profiler.counts.skipped} of them were not profiled.`,
      { suggestion: 'Check --format and --delimiter, and confirm the input holds records at all.' },
    )
    profiler.incomplete = true
  }
  return buildReport(profiler, { bytes })
}

function prepare(options, allowed, path) {
  rejectUnknownOptions(options, allowed)
  return {
    format: validateFormat(options.format, path),
    limits: validateLimits(options.limits),
    delimiter: validateDelimiter(options.delimiter ?? DEFAULT_DELIMITER),
    nullTokens: validateNullTokens(options.nullTokens),
    nullRatio: validateNullRatio(options.nullRatio),
    clock: validateClock(options.clock),
  }
}

/**
 * Profile bytes already in memory.
 *
 * The same code path as a file, fed one chunk, so the strict decoding and every
 * limit apply identically. This is how an invalid byte sequence is tested
 * without writing one to disk first.
 */
export async function profileBytes(bytes, options = {}) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Bytes must be a Uint8Array')
  const file = options.file === undefined ? 'input' : options.file
  if (typeof file !== 'string' || file.trim() === '') throw new TypeError('File label must be a non-empty string')
  const settings = prepare(options, TEXT_OPTIONS, file)
  return profileSource([bytes], { ...settings, file: excerpt(file, 200) })
}

/** Profile text that does not live on disk. No filesystem access. */
export async function profileText(text, options = {}) {
  if (typeof text !== 'string') throw new TypeError('Input text must be a string')
  return profileBytes(new TextEncoder().encode(text), options)
}

/**
 * Profile a file, streamed.
 *
 * The file is opened read-only and never written to: this module imports no
 * write API at all. The reported `location.file` is relative to the declared
 * root, so an absolute host path never reaches the report.
 */
export async function profileFile(options = {}) {
  rejectUnknownOptions(options, FILE_OPTIONS)
  if (typeof options.input !== 'string' || options.input.trim() === '') {
    throw new TypeError('An input path is required')
  }
  if (options.root !== undefined && (typeof options.root !== 'string' || options.root.trim() === '')) {
    throw new TypeError('Root must be a non-empty string')
  }
  const settings = prepare(options, FILE_OPTIONS, options.input)

  /**
   * The root is resolved before the input.
   *
   * A root that cannot be read is a configuration error whatever the input
   * turns out to be, and a configuration error is a run that never had a
   * subject. Resolving the input first would let a missing input turn a
   * misspelled root into an ordinary incomplete report, which is the quieter
   * and more misleading of the two answers.
   */
  let rootReal = null
  if (options.root !== undefined) {
    try {
      rootReal = await realpath(resolve(options.root))
    } catch (error) {
      throw new TypeError(`Root could not be read: ${error.code ?? 'unknown error'}`)
    }
  }

  let inputReal
  try {
    inputReal = await realpath(resolve(options.input))
  } catch (error) {
    return unreadable(excerpt(basename(options.input), 200), settings, `the path could not be resolved (${error.code ?? 'unknown error'})`)
  }
  if (rootReal === null) rootReal = dirname(inputReal)

  const label = excerpt(relative(rootReal, inputReal) || basename(inputReal), 200)

  if (!isInside(rootReal, inputReal)) {
    const profiler = new Profiler({ ...settings, file: excerpt(basename(inputReal), 200) })
    profiler.incomplete = true
    profiler.noteInput(
      'input-escapes-root',
      'The input resolves outside the declared root, so it was refused unread. A symbolic link inside a root is still a path out of it.',
      { suggestion: 'Point --root at the tree the input really lives in, or move the file inside it.' },
    )
    return finalize(profiler, 0)
  }

  const info = await stat(inputReal).catch(() => null)
  if (info === null || !info.isFile()) {
    return unreadable(label, settings, 'the path is not a regular file')
  }

  return profileSource(createReadStream(inputReal), { ...settings, file: label })
}

/** A report for an input that could not be opened at all. Incomplete, never a pass. */
function unreadable(label, settings, reason) {
  const profiler = new Profiler({ ...settings, file: label })
  profiler.incomplete = true
  profiler.noteInput('input-unreadable', `The input could not be read: ${reason}.`, {
    suggestion: 'Check the path and its permissions.',
  })
  return finalize(profiler, 0)
}

const SEVERITY_WIDTH = 7
const NAME_WIDTH = 22
const FAMILY_WIDTH = 18

/** The human summary. Every value in it has been masked; every name sanitised. */
export function formatReport(report) {
  const { profile, summary } = report
  const lines = [
    `${profile.file} (${profile.format}): ${summary.checked} record(s) profiled, ${summary.errors} error, ${summary.warnings} warning, ${summary.info} info, status ${report.status}.`,
    `records: ${summary.records} found, ${summary.profiled} attributed to columns, ${summary.skipped} not profiled, ${summary.driftedRecords} shape drift, ${summary.duplicateKeys} duplicate key(s); ${summary.bytes} byte(s) read.`,
    `columns: ${summary.columns}; ${summary.nulls} null value(s). Values below are masked shapes, not data.`,
  ]

  if (profile.columns.length > 0) {
    lines.push(`${'column'.padEnd(NAME_WIDTH)} ${'families'.padEnd(FAMILY_WIDTH)} nulls  length  sample`)
    for (const column of profile.columns) {
      const name = column.name === '' ? `#${column.index}` : column.name
      const families = column.families.length === 0 ? '-' : column.families.join(',')
      const nulls = `${column.nulls + column.absent}/${summary.profiled}`
      const length = `${column.minLength}-${column.maxLength}`
      const sample = column.samples.length === 0 ? '-' : column.samples[0].value
      lines.push(
        `${name.padEnd(NAME_WIDTH)} ${families.padEnd(FAMILY_WIDTH)} ${nulls.padEnd(6)} ${length.padEnd(7)} ${sample}`,
      )
    }
  }

  for (const finding of report.findings) {
    const place = finding.line === undefined
      ? `${finding.location.file}${finding.location.pointer}`
      : `${finding.location.file}:${finding.line}${finding.location.pointer}`
    const quoted = finding.evidence === undefined ? '' : ` -- ${finding.evidence}`
    lines.push(`${finding.severity.toUpperCase().padEnd(SEVERITY_WIDTH)} ${place} ${finding.ruleId} ${finding.message}${quoted}`)
  }
  return `${lines.join('\n')}\n`
}

export { CsvReader, DEFAULT_DELIMITER, parseCsv, validateDelimiter } from './csv.mjs'
export { JsonRecordReader, inspectJsonText, parseJsonRecords, pointerSegment } from './json.mjs'
export { Profiler, RULE_SEVERITY, SECTIONS, SEVERITY_VALUES, createFinding, sortFindings } from './profile.mjs'
export {
  EXCERPT_LIMIT,
  MASK_LIMIT,
  byCodeUnit,
  excerpt,
  hasBom,
  mask,
  parseFailureDetail,
  sanitize,
  utf8Length,
} from './text.mjs'
export {
  FAMILIES,
  TYPES,
  classifyCsvValue,
  classifyJsonValue,
  familyOf,
  hasLeadingZeros,
  isIsoDate,
  isPadded,
  isUnsafeInteger,
  valueText,
} from './values.mjs'
