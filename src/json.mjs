/**
 * csv-json-import-profiler -- streaming JSON record readers.
 *
 * Two shapes are read, both without holding the whole file:
 *
 * - `json`: one top-level array whose elements are the records. The scanner
 *   tracks string, escape and nesting state so it can cut the array into
 *   elements at the commas that actually separate them, and hands one element
 *   at a time to `JSON.parse`. Memory is bounded by the largest record, not by
 *   the file.
 * - `jsonl`: one JSON value per line, the NDJSON convention.
 *
 * Structure is inspected before it is parsed. `inspectJsonText` reports the
 * nesting depth and every repeated object key, because `JSON.parse` answers
 * neither question: it silently keeps the last value for a repeated key, so a
 * record carrying `"email"` twice loads with one of the two values and no
 * complaint anywhere. That is a data-loss defect an import profiler exists to
 * catch, and it is invisible to any check performed on the parsed object.
 */

const WHITESPACE = new Set([' ', '\t', '\n', '\r'])

/** Escape a JSON Pointer segment (RFC 6901). */
export function pointerSegment(name) {
  return String(name).replace(/~/g, '~0').replace(/\//g, '~1')
}

/**
 * Scan one record's text for nesting depth and repeated object keys.
 *
 * Deliberately permissive about validity: `JSON.parse` remains the authority on
 * whether the record is JSON at all, and a scanner that also tried to be a
 * validator would be a second, disagreeing parser. This one answers only the
 * two questions `JSON.parse` cannot.
 */
export function inspectJsonText(text) {
  const frames = []
  const duplicates = []
  let depth = 0
  let index = 0

  const path = (extra) => {
    const parts = frames.slice(0, -1).map((frame) => frame.segment)
    parts.push(extra)
    return `/${parts.filter((part) => part !== null).map(pointerSegment).join('/')}`
  }

  const readString = () => {
    index += 1
    let value = ''
    while (index < text.length) {
      const character = text[index]
      if (character === '\\') {
        value += text.slice(index, index + 2)
        index += 2
        continue
      }
      if (character === '"') {
        index += 1
        return value
      }
      value += character
      index += 1
    }
    return value
  }

  while (index < text.length) {
    const character = text[index]

    if (character === '"') {
      const raw = readString()
      const top = frames[frames.length - 1]
      if (top !== undefined && top.type === 'object' && top.expectKey) {
        let key = raw
        try {
          key = JSON.parse(`"${raw}"`)
        } catch {
          key = raw
        }
        if (top.keys.has(key)) duplicates.push({ key, pointer: path(key) })
        top.keys.add(key)
        top.segment = key
        top.expectKey = false
      }
      continue
    }

    if (character === '{' || character === '[') {
      const type = character === '{' ? 'object' : 'array'
      frames.push({ type, keys: new Set(), expectKey: type === 'object', segment: type === 'array' ? '0' : null })
      depth = Math.max(depth, frames.length)
      index += 1
      continue
    }

    if (character === '}' || character === ']') {
      frames.pop()
      index += 1
      continue
    }

    if (character === ',') {
      const top = frames[frames.length - 1]
      if (top !== undefined) {
        if (top.type === 'object') top.expectKey = true
        else top.segment = String(Number(top.segment) + 1)
      }
      index += 1
      continue
    }

    index += 1
  }

  return { depth: Math.max(depth, 1), duplicates }
}

/**
 * A streaming reader over a top-level JSON array or over NDJSON lines.
 *
 * Memory is bounded by `maxRecordChars`: past it the record's text is dropped
 * and only the scan continues, so the reader still finds where the record ends
 * and carries on with the next one.
 */
export class JsonRecordReader {
  constructor(options = {}) {
    this.mode = options.mode === 'lines' ? 'lines' : 'array'
    this.maxRecordChars = options.maxRecordChars ?? Number.POSITIVE_INFINITY
    this.phase = this.mode === 'lines' ? 'element' : 'before'
    this.text = ''
    this.chars = 0
    this.truncated = false
    this.line = 1
    this.currentLine = 1
    this.started = false
    this.depth = 0
    this.inString = false
    this.escaped = false
    this.failed = false
    this.finished = false
    this.error = null
  }

  fail(kind, detail) {
    if (this.failed) return
    this.failed = true
    this.error = { kind, line: this.currentLine, detail }
  }

  keep(character) {
    this.chars += 1
    if (this.chars > this.maxRecordChars) {
      this.truncated = true
      return
    }
    this.text += character
  }

  emit(records) {
    const text = this.text.trim()
    if (text === '' && !this.truncated) {
      this.reset()
      return
    }
    records.push({ line: this.line, text, chars: this.chars, truncated: this.truncated })
    this.reset()
  }

  reset() {
    this.text = ''
    this.chars = 0
    this.truncated = false
    this.started = false
    this.depth = 0
    this.line = this.currentLine
  }

  push(input) {
    const records = []
    for (let index = 0; index < input.length && !this.failed; index += 1) {
      const character = input[index]
      if (character === '\n') this.currentLine += 1

      if (this.phase === 'before') {
        if (WHITESPACE.has(character)) continue
        if (character === '[') {
          this.phase = 'element'
          this.line = this.currentLine
          continue
        }
        this.fail('not-array', character)
        continue
      }

      if (this.phase === 'after') {
        if (!WHITESPACE.has(character)) this.fail('trailing-content', character)
        continue
      }

      if (this.mode === 'lines') {
        if (character === '\n') {
          this.emit(records)
          continue
        }
        if (!this.started && WHITESPACE.has(character)) continue
        if (!this.started) {
          this.started = true
          this.line = this.currentLine
        }
        this.keep(character)
        continue
      }

      if (this.inString) {
        this.keep(character)
        if (this.escaped) this.escaped = false
        else if (character === '\\') this.escaped = true
        else if (character === '"') this.inString = false
        continue
      }

      if (!this.started) {
        if (WHITESPACE.has(character)) continue
        if (character === ']' && this.depth === 0) {
          // The array closed with no element in progress: either it was empty
          // or the previous element ended at the comma before this bracket.
          this.phase = 'after'
          continue
        }
        this.started = true
        this.line = this.currentLine
      }

      if (character === '"') {
        this.inString = true
        this.keep(character)
        continue
      }

      if (character === '{' || character === '[') {
        this.depth += 1
        this.keep(character)
        continue
      }

      if (character === '}' || character === ']') {
        if (this.depth === 0 && character === ']') {
          this.emit(records)
          this.phase = 'after'
          continue
        }
        this.depth -= 1
        this.keep(character)
        continue
      }

      if (character === ',' && this.depth === 0) {
        this.emit(records)
        continue
      }

      this.keep(character)
    }
    return records
  }

  end() {
    const records = []
    if (this.failed) return { records, error: this.error }
    if (this.mode === 'lines') {
      if (this.started || this.truncated) this.emit(records)
      return { records, error: null }
    }
    if (this.phase === 'before') {
      this.fail('not-array', 'end of input')
      return { records, error: this.error }
    }
    if (this.phase === 'element') {
      this.fail('unterminated-array', 'end of input')
      return { records, error: this.error }
    }
    return { records, error: null }
  }
}

/** Read a whole JSON string. The same readers, fed once. */
export function parseJsonRecords(text, options = {}) {
  const reader = new JsonRecordReader(options)
  const records = reader.push(text)
  const tail = reader.end()
  return { records: records.concat(tail.records), error: tail.error }
}
