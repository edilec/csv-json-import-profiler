/**
 * csv-json-import-profiler -- the rules, the severity table, and the profile.
 *
 * This module decides what a stream of records says about itself. It reads
 * records and writes findings; it never reads the filesystem, the clock or the
 * network, and it never rewrites a value. Field content arrives here as text,
 * is masked, and leaves as a shape.
 */

import { inspectJsonText, pointerSegment } from './json.mjs'
import { byCodeUnit, excerpt, mask, utf8Length } from './text.mjs'
import {
  classifyCsvValue,
  classifyJsonValue,
  familyOf,
  hasLeadingZeros,
  isPadded,
  isUnsafeInteger,
  valueText,
} from './values.mjs'

/**
 * The authoritative rule severity table.
 *
 * Severity is the whole difference between a run that fails and one that
 * passes. Written as a literal at each construction site it drifts silently,
 * and one rule quietly demoted to `warning` turns a refusal into a green build
 * with every test still passing. Every finding takes its severity from here, an
 * unknown rule id throws, and `docs/import-profile-rules.md` is asserted
 * against this table in both directions.
 *
 * The table is the source of truth. It is deliberately *not* the test: three
 * declarations agreeing with each other can be edited together, so every
 * severity that decides a verdict is additionally pinned by running the real
 * binary and asserting the exit code.
 */
export const RULE_SEVERITY = Object.freeze({
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

export const SEVERITY_VALUES = Object.freeze(['error', 'warning', 'info'])

/** Report sections, ranked. Findings about the input come before the detail. */
export const SECTIONS = Object.freeze({ input: 0, columns: 1, records: 2 })

const MESSAGE_LIMIT = 320
const PATH_LIMIT = 200
const EVIDENCE_LIMIT = 160
const SAMPLE_FAMILIES = 4
const DRIFT_NAMES = 6

/**
 * Build one finding, taking its severity from the single table.
 *
 * Every untrusted string is sanitised here, not only `evidence`: a column name
 * carrying U+0085 forges a report line exactly as well as a field value does,
 * and a file label is no safer than either. Exported so a test can prove the
 * refusal below actually throws.
 */
export function createFinding(row) {
  const severity = Object.hasOwn(RULE_SEVERITY, row.ruleId) ? RULE_SEVERITY[row.ruleId] : undefined
  if (severity === undefined) {
    throw new Error(
      `Rule "${row.ruleId}" is not in RULE_SEVERITY; add it to the table and to docs/import-profile-rules.md.`,
    )
  }
  const finding = {
    ruleId: row.ruleId,
    severity,
    message: excerpt(row.message, MESSAGE_LIMIT),
    location: { file: excerpt(row.file, PATH_LIMIT), pointer: excerpt(row.pointer, PATH_LIMIT) },
  }
  if (row.evidence !== undefined && row.evidence !== '') finding.evidence = excerpt(row.evidence, EVIDENCE_LIMIT)
  if (row.suggestion !== undefined) finding.suggestion = excerpt(row.suggestion, MESSAGE_LIMIT)
  if (row.record > 0) finding.record = row.record
  if (row.line > 0) finding.line = row.line
  return finding
}

/**
 * Order findings by `(file, section, record, pointer, ruleId)`.
 *
 * The record number is compared numerically, because record 9 comes before
 * record 10 to every reader and after it to every string comparison. Everything
 * textual is compared by UTF-16 code unit -- never by `localeCompare` or
 * `Intl.Collator`, whose ICU data differs between Node builds. Ties keep
 * insertion order, which `Array.prototype.sort` has guaranteed to be stable
 * since ES2019.
 */
export function sortFindings(rows) {
  return [...rows].sort((left, right) => {
    const file = byCodeUnit(left.file, right.file)
    if (file !== 0) return file
    if (left.section !== right.section) return left.section - right.section
    if (left.record !== right.record) return left.record - right.record
    const pointer = byCodeUnit(left.pointer, right.pointer)
    if (pointer !== 0) return pointer
    return byCodeUnit(left.ruleId, right.ruleId)
  })
}

function createColumn(name, index) {
  return {
    name,
    index,
    seen: 0,
    nulls: 0,
    empty: 0,
    padded: 0,
    unsafe: 0,
    leadingZeros: 0,
    minLength: 0,
    maxLength: 0,
    types: new Map(),
    families: new Map(),
  }
}

/** The pointer a column is reported under. An unnamed column is reported by index. */
function columnPointer(column) {
  const name = excerpt(column.name, PATH_LIMIT)
  return name === '' ? `/columns/#${column.index}` : `/columns/${pointerSegment(name)}`
}

function columnLabel(column) {
  const name = excerpt(column.name, 80)
  return name === '' ? `#${column.index} (unnamed)` : `"${name}"`
}

/**
 * The streaming profiler.
 *
 * Records arrive one at a time and leave as counters. Nothing is buffered
 * beyond the column table and one masked sample per type family, so profiling a
 * file costs the same whether it holds ten records or ten thousand.
 */
export class Profiler {
  constructor(options) {
    this.file = options.file
    this.format = options.format
    this.nullTokens = options.nullTokens ?? []
    this.nullRatio = options.nullRatio
    this.limits = options.limits
    this.columns = []
    this.columnByName = new Map()
    this.header = null
    this.rows = []
    this.capped = false
    this.incomplete = false
    this.stopped = false
    this.referenceKeys = null
    this.counts = {
      records: 0,
      checked: 0,
      profiled: 0,
      skipped: 0,
      drifted: 0,
      duplicateKeys: 0,
      nulls: 0,
    }
  }

  /**
   * Record a finding, bounded.
   *
   * The findings list is an output with a limit like any other. When it fills,
   * the limit is named in a finding of its own and the run is incomplete --
   * a report that stopped collecting without saying so would be a quieter lie
   * than a truncated file.
   */
  note(row) {
    if (this.capped) return
    if (this.rows.length + 1 >= this.limits.maxFindings) {
      this.rows.push({
        file: this.file,
        section: SECTIONS.input,
        record: 0,
        line: 0,
        pointer: '/input',
        ruleId: 'too-many-findings',
        message: `The report reached the maxFindings limit of ${this.limits.maxFindings}, so later findings were not collected and this profile is partial.`,
        suggestion: 'Raise --max-findings, or fix one class of finding and profile the input again.',
      })
      this.capped = true
      this.incomplete = true
      return
    }
    this.rows.push({ file: this.file, record: 0, line: 0, ...row })
  }

  /** A finding about the input as a whole. */
  noteInput(ruleId, message, extra = {}) {
    this.note({ section: SECTIONS.input, pointer: '/input', ruleId, message, ...extra })
  }

  stop(ruleId, message, extra = {}) {
    this.noteInput(ruleId, message, extra)
    this.incomplete = true
    this.stopped = true
  }

  /**
   * The column a value belongs to.
   *
   * CSV columns are keyed by position as well as name, because a header that
   * repeats a name has two columns and they are not the same column. JSON
   * columns are keyed by name alone, because a field is the same field wherever
   * in the record it appears.
   */
  column(name, index) {
    const key = index === undefined ? `json:${name}` : `csv:${index}:${name}`
    const existing = this.columnByName.get(key)
    if (existing !== undefined) return existing
    const created = createColumn(name, index ?? this.columns.length)
    this.columns.push(created)
    this.columnByName.set(key, created)
    return created
  }

  /** Whether adding another column would pass the declared limit. */
  columnsExhausted(count) {
    if (count <= this.limits.maxColumns) return false
    this.stop(
      'too-many-columns',
      `The input declares ${count} column(s), past the maxColumns limit of ${this.limits.maxColumns}. Profiling stopped, so this report describes only part of the input.`,
      { suggestion: 'Raise --max-columns, or split the input into narrower files.' },
    )
    return true
  }

  /** Whether this record would pass the declared record limit. */
  recordsExhausted() {
    if (this.counts.records <= this.limits.maxRecords) return false
    this.stop(
      'too-many-records',
      `The input holds more than the maxRecords limit of ${this.limits.maxRecords}. Profiling stopped, so this report describes only the first ${this.limits.maxRecords} record(s).`,
      { suggestion: 'Raise --max-records, or profile a bounded sample deliberately rather than by accident.' },
    )
    return true
  }

  /**
   * A record that arrived larger than the row limit.
   *
   * The row is reported by number and size and is not profiled: its values
   * cannot be attributed to columns without reading the part that was refused.
   * That makes the run incomplete rather than merely noisy.
   */
  noteOversizedRow(ordinal, line, size, exact) {
    this.counts.skipped += 1
    this.incomplete = true
    this.note({
      section: SECTIONS.records,
      pointer: `/records/${ordinal}`,
      record: ordinal,
      line,
      ruleId: 'row-too-large',
      message: `Record ${ordinal} is ${exact ? `${size} bytes` : `at least ${size} characters`}, past the maxRowBytes limit of ${this.limits.maxRowBytes}. It was not profiled.`,
      suggestion: 'Raise --max-row-bytes if the record is legitimate, or look for an unclosed quote joining several rows into one.',
    })
  }

  /** True when the record is within the row limit; records the finding when it is not. */
  withinRowLimit(record, ordinal) {
    if (record.truncated) {
      this.noteOversizedRow(ordinal, record.line, record.chars, false)
      return false
    }
    const bytes = utf8Length(record.raw ?? record.text)
    if (bytes > this.limits.maxRowBytes) {
      this.noteOversizedRow(ordinal, record.line, bytes, true)
      return false
    }
    return true
  }

  /** Read the CSV header row. Column names are schema, so they are not masked. */
  readHeader(record) {
    const names = record.fields.map((field) => field.value)
    if (this.columnsExhausted(names.length)) return
    this.header = names
    const seen = new Map()
    names.forEach((rawName, index) => {
      const name = rawName
      const column = this.column(name, index)
      if (name.trim() === '') {
        this.note({
          section: SECTIONS.columns,
          pointer: columnPointer(column),
          line: record.line,
          ruleId: 'header-column-unnamed',
          message: `Column ${index + 1} of the header has no name, so nothing downstream can refer to it by one.`,
          suggestion: 'Name the column in the header row, or drop it from the export.',
        })
      }
      const first = seen.get(name)
      if (first === undefined) seen.set(name, index)
      else {
        this.note({
          section: SECTIONS.columns,
          pointer: columnPointer(column),
          line: record.line,
          ruleId: 'duplicate-header-key',
          message: `Header name ${columnLabel(column)} appears at column ${first + 1} and again at column ${index + 1}; an importer keying by name will keep one of them and drop the other silently.`,
          suggestion: 'Give the repeated columns distinct names before importing.',
        })
      }
    })
  }

  /** Profile one CSV data row. */
  readCsvRecord(record, ordinal) {
    if (!this.withinRowLimit(record, ordinal)) return
    this.counts.checked += 1

    if (record.fields.length !== this.header.length) {
      this.counts.drifted += 1
      this.note({
        section: SECTIONS.records,
        pointer: `/records/${ordinal}`,
        record: ordinal,
        line: record.line,
        ruleId: 'row-field-count-drift',
        message: `Record ${ordinal} has ${record.fields.length} field(s) where the header declares ${this.header.length}; its values cannot be attributed to columns, so they are not in this profile.`,
        evidence: mask(record.raw),
        suggestion: 'Look for an unescaped delimiter or quote in the row; an importer will either reject it or shift every value one column to the left.',
      })
      return
    }

    this.counts.profiled += 1
    record.fields.forEach((field, index) => {
      const column = this.column(this.header[index], index)
      const type = classifyCsvValue(field.value, { quoted: field.quoted, nullTokens: this.nullTokens })
      this.observe(column, type, field.value, ordinal)
    })
  }

  /** Profile one JSON record: structure first, then the parse. */
  readJsonRecord(record, ordinal) {
    if (!this.withinRowLimit(record, ordinal)) return

    const inspected = inspectJsonText(record.text)
    if (inspected.depth > this.limits.maxDepth) {
      this.counts.skipped += 1
      this.incomplete = true
      this.note({
        section: SECTIONS.records,
        pointer: `/records/${ordinal}`,
        record: ordinal,
        line: record.line,
        ruleId: 'record-too-deep',
        message: `Record ${ordinal} nests ${inspected.depth} level(s) deep, past the maxDepth limit of ${this.limits.maxDepth}. It was not parsed or profiled.`,
        suggestion: 'Raise --max-depth if the shape is genuine, or flatten the record before importing it.',
      })
      return
    }

    let value
    try {
      value = JSON.parse(record.text)
    } catch (error) {
      this.counts.skipped += 1
      this.incomplete = true
      this.note({
        section: SECTIONS.records,
        pointer: `/records/${ordinal}`,
        record: ordinal,
        line: record.line,
        ruleId: 'record-not-json',
        message: `Record ${ordinal} is not valid JSON, so nothing is known about it: ${error.message}`,
        evidence: mask(record.text),
        suggestion: 'Fix the record at the reported line; a profile that guessed at its shape would be worse than this gap.',
      })
      return
    }

    this.counts.checked += 1

    for (const duplicate of inspected.duplicates) {
      this.counts.duplicateKeys += 1
      this.note({
        section: SECTIONS.records,
        pointer: `/records/${ordinal}${duplicate.pointer}`,
        record: ordinal,
        line: record.line,
        ruleId: 'duplicate-object-key',
        message: `Record ${ordinal} sets the key "${excerpt(duplicate.key, 60)}" more than once; JSON.parse keeps the last value and every earlier one is lost without a diagnostic.`,
        suggestion: 'Remove the repeated key at the source. A parser cannot tell you which value was meant.',
      })
    }

    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      this.note({
        section: SECTIONS.records,
        pointer: `/records/${ordinal}`,
        record: ordinal,
        line: record.line,
        ruleId: 'record-not-an-object',
        message: `Record ${ordinal} is ${Array.isArray(value) ? 'an array' : `a ${value === null ? 'null' : typeof value}`}, not an object, so it carries no named fields to import.`,
        evidence: mask(valueText(value)),
        suggestion: 'Emit one object per record, or profile this file as a value list rather than an import.',
      })
      return
    }

    const keys = Object.keys(value)
    if (this.columnsExhausted(new Set([...this.columns.map((column) => column.name), ...keys]).size)) return

    if (this.referenceKeys === null) this.referenceKeys = [...keys].sort(byCodeUnit)
    else this.noteKeyDrift(keys, ordinal, record.line)

    this.counts.profiled += 1
    for (const key of keys) {
      const column = this.column(key)
      this.observe(column, classifyJsonValue(value[key]), valueText(value[key]), ordinal)
    }
  }

  noteKeyDrift(keys, ordinal, line) {
    const present = new Set(keys)
    const missing = this.referenceKeys.filter((key) => !present.has(key))
    const extra = [...keys].sort(byCodeUnit).filter((key) => !this.referenceKeys.includes(key))
    if (missing.length === 0 && extra.length === 0) return
    const describe = (names) =>
      names
        .slice(0, DRIFT_NAMES)
        .map((name) => excerpt(name, 40))
        .join(', ') + (names.length > DRIFT_NAMES ? ', ...' : '')
    const parts = []
    if (missing.length > 0) parts.push(`missing ${missing.length}: ${describe(missing)}`)
    if (extra.length > 0) parts.push(`extra ${extra.length}: ${describe(extra)}`)
    this.note({
      section: SECTIONS.records,
      pointer: `/records/${ordinal}`,
      record: ordinal,
      line,
      ruleId: 'record-key-drift',
      message: `Record ${ordinal} has a different key set from the first record (${parts.join('; ')}).`,
      suggestion: 'Decide whether the key is optional or absent by mistake; an importer will make that decision for you.',
    })
  }

  /**
   * Fold one value into a column.
   *
   * The value is counted and masked. It is never coerced: a column holding
   * `42` and `forty-two` ends with two families, which is the finding, not a
   * problem to be smoothed over by picking the more popular type.
   */
  observe(column, type, text, ordinal) {
    column.seen += 1
    column.types.set(type, (column.types.get(type) ?? 0) + 1)

    if (type === 'null') {
      column.nulls += 1
      this.counts.nulls += 1
      return
    }
    if (type === 'empty') column.empty += 1

    const family = familyOf(type)
    const known = column.families.get(family)
    if (known === undefined) {
      column.families.set(family, { count: 1, record: ordinal, sample: mask(text), type })
    } else {
      known.count += 1
    }

    const length = Array.from(text).length
    if (column.seen === column.nulls + 1 || length < column.minLength) column.minLength = length
    if (length > column.maxLength) column.maxLength = length

    if (isPadded(text)) column.padded += 1
    if (type === 'integer') {
      if (isUnsafeInteger(text)) column.unsafe += 1
      if (hasLeadingZeros(text)) column.leadingZeros += 1
    }
  }

  /** Evaluate the column rules once the stream has ended. */
  finish() {
    for (const column of this.columns) {
      const absent = Math.max(this.counts.profiled - column.seen, 0)
      const missing = column.nulls + absent
      const pointer = columnPointer(column)
      const label = columnLabel(column)

      if (column.families.size > 1) {
        const families = [...column.families.entries()].sort((left, right) => byCodeUnit(left[0], right[0]))
        const evidence = families
          .slice(0, SAMPLE_FAMILIES)
          .map(([family, info]) => `record ${info.record} ${family}/${info.type} ${info.sample}`)
          .join(' | ')
        this.note({
          section: SECTIONS.columns,
          pointer,
          ruleId: 'column-type-mixed',
          message: `Column ${label} holds ${column.families.size} type families (${families.map(([family]) => family).join(', ')}); an importer that typed the column from its first rows will reject the rest. No value was coerced to produce this profile.`,
          evidence,
          suggestion: 'Decide the column type at the source, or import it as text and cast after loading.',
        })
      }

      if (this.counts.profiled > 0 && missing === this.counts.profiled) {
        this.note({
          section: SECTIONS.columns,
          pointer,
          ruleId: 'column-all-null',
          message: `Column ${label} is null or absent in all ${this.counts.profiled} profiled record(s), so the input carries no evidence of what it holds.`,
          suggestion: 'Drop the column from the import, or find out why the export never fills it.',
        })
      } else if (this.counts.profiled > 0 && missing / this.counts.profiled > this.nullRatio) {
        this.note({
          section: SECTIONS.columns,
          pointer,
          ruleId: 'column-null-ratio-high',
          message: `Column ${label} is null or absent in ${missing} of ${this.counts.profiled} profiled record(s), past the configured ratio of ${this.nullRatio}.`,
          suggestion: 'Confirm the column is genuinely optional before importing it as NOT NULL.',
        })
      }

      if (column.padded > 0) {
        this.note({
          section: SECTIONS.columns,
          pointer,
          ruleId: 'column-value-padded',
          message: `Column ${label} has ${column.padded} value(s) with leading or trailing whitespace, which this profile counts as part of the value because an importer may keep it.`,
          suggestion: 'Trim at the source, or trim explicitly on import so the decision is written down.',
        })
      }

      if (column.unsafe > 0) {
        this.note({
          section: SECTIONS.columns,
          pointer,
          ruleId: 'column-integer-unsafe',
          message: `Column ${label} has ${column.unsafe} integer(s) outside the exact range of a double, so any JSON or JavaScript importer will round them.`,
          suggestion: 'Import the column as text or a decimal type, not as a number.',
        })
      }

      if (column.leadingZeros > 0) {
        this.note({
          section: SECTIONS.columns,
          pointer,
          ruleId: 'column-integer-leading-zeros',
          message: `Column ${label} has ${column.leadingZeros} integer-looking value(s) with leading zeros; typed as a number they lose the zeros, and postcodes and part numbers never come back.`,
          suggestion: 'Import the column as text.',
        })
      }
    }
  }

  /** The profile: what the input is, as opposed to what is wrong with it. */
  profile() {
    return {
      file: excerpt(this.file, PATH_LIMIT),
      format: this.format,
      records: this.counts.records,
      profiled: this.counts.profiled,
      columns: this.columns.map((column) => ({
        name: excerpt(column.name, PATH_LIMIT),
        index: column.index,
        seen: column.seen,
        absent: Math.max(this.counts.profiled - column.seen, 0),
        nulls: column.nulls,
        empty: column.empty,
        padded: column.padded,
        minLength: column.minLength,
        maxLength: column.maxLength,
        families: [...column.families.keys()].sort(byCodeUnit),
        types: Object.fromEntries([...column.types.entries()].sort((left, right) => byCodeUnit(left[0], right[0]))),
        samples: [...column.families.entries()]
          .sort((left, right) => byCodeUnit(left[0], right[0]))
          .slice(0, SAMPLE_FAMILIES)
          .map(([family, info]) => ({ record: info.record, family, type: info.type, value: excerpt(info.sample, EVIDENCE_LIMIT) })),
      })),
    }
  }
}
