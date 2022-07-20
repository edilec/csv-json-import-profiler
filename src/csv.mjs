/**
 * csv-json-import-profiler -- a streaming RFC 4180 reader.
 *
 * Text arrives in chunks of whatever size the filesystem hands over, and a
 * record may straddle any number of them, so this is a character state machine
 * rather than a `split` over a whole file. That is not an optimisation: a
 * reader that splits on newlines first cannot see that a newline sits inside a
 * quoted field, and it is exactly the multiline quoted record -- an address, a
 * comment, a pasted paragraph -- that breaks naive importers.
 *
 * What the reader implements from RFC 4180:
 *
 * - a quoted field may contain the delimiter,
 * - a quoted field may contain CR, LF or CRLF, kept literally,
 * - `""` inside a quoted field is one literal quote,
 * - CRLF, LF and a lone CR all end a record outside quotes.
 *
 * Where real files leave the standard, the behaviour is chosen and documented
 * rather than accidental: a quote inside an unquoted field is literal text,
 * text after a closing quote is appended as literal text, and a completely
 * empty line is skipped instead of being reported as a one-field record.
 *
 * Memory is bounded by `maxRecordChars`. Once a record passes it the reader
 * stops accumulating and keeps parsing only far enough to find the end of that
 * record, so a 2 GB unterminated quoted field costs no more than any other.
 */

export const DEFAULT_DELIMITER = ','
const QUOTE = '"'

const FIELD_START = 0
const UNQUOTED = 1
const QUOTED = 2
const AFTER_QUOTE = 3

/** Delimiters a caller may choose. A quote or a line ending is not one. */
export function validateDelimiter(delimiter) {
  if (typeof delimiter !== 'string' || Array.from(delimiter).length !== 1) {
    throw new TypeError('Delimiter must be a single character')
  }
  if (delimiter === QUOTE || delimiter === '\n' || delimiter === '\r') {
    throw new TypeError('Delimiter must not be a quote or a line ending')
  }
  return delimiter
}

export class CsvReader {
  constructor(options = {}) {
    this.delimiter = validateDelimiter(options.delimiter ?? DEFAULT_DELIMITER)
    this.maxRecordChars = options.maxRecordChars ?? Number.POSITIVE_INFINITY
    this.state = FIELD_START
    this.field = ''
    this.fieldQuoted = false
    this.fields = []
    this.raw = ''
    this.chars = 0
    this.line = 1
    this.currentLine = 1
    this.pendingCr = false
    this.truncated = false
    this.endings = { cr: 0, crlf: 0, lf: 0 }
  }

  /** Whether a record is currently being built. */
  get open() {
    return this.chars > 0 || this.fields.length > 0 || this.state !== FIELD_START
  }

  /**
   * Account for one consumed character.
   *
   * Past the bound the content is dropped and only the shape of the parse is
   * tracked. The record is still finished, so the reader resynchronises on the
   * next one instead of abandoning the rest of the file.
   */
  count(character) {
    this.chars += 1
    if (this.chars > this.maxRecordChars) {
      this.truncated = true
      return false
    }
    this.raw += character
    return true
  }

  /** Account for a character and keep it as field content. */
  consume(character) {
    if (this.count(character)) this.field += character
  }

  finishField() {
    this.fields.push({ value: this.field, quoted: this.fieldQuoted })
    this.field = ''
    this.fieldQuoted = false
    this.state = FIELD_START
  }

  finishRecord(records) {
    const empty = this.fields.length === 0 && this.field === '' && this.chars === 0
    if (!empty) {
      this.fields.push({ value: this.field, quoted: this.fieldQuoted })
      records.push({
        line: this.line,
        fields: this.fields,
        raw: this.raw,
        chars: this.chars,
        truncated: this.truncated,
      })
    }
    this.fields = []
    this.field = ''
    this.fieldQuoted = false
    this.raw = ''
    this.chars = 0
    this.truncated = false
    this.state = FIELD_START
    this.line = this.currentLine
  }

  /** Feed decoded text. Returns every record completed by this chunk. */
  push(text) {
    const records = []
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index]

      if (this.pendingCr) {
        this.pendingCr = false
        if (character === '\n') {
          this.endings.cr -= 1
          this.endings.crlf += 1
          continue
        }
      }

      if (this.state === QUOTED) {
        if (character === QUOTE) {
          this.state = AFTER_QUOTE
          this.count(character)
        } else {
          // A newline inside quotes is content, not a record separator, so it
          // advances the line number and is not counted as a line ending. A
          // multiline field must not make a file look like it mixes CRLF
          // and LF.
          if (character === '\n') this.currentLine += 1
          this.consume(character)
        }
        continue
      }

      if (this.state === AFTER_QUOTE && character === QUOTE) {
        // A doubled quote inside a quoted field is one literal quote.
        this.state = QUOTED
        this.consume(character)
        continue
      }

      if (character === this.delimiter) {
        this.finishField()
        this.count(character)
        continue
      }

      if (character === '\n' || character === '\r') {
        this.currentLine += 1
        if (character === '\n') this.endings.lf += 1
        else {
          this.endings.cr += 1
          this.pendingCr = true
        }
        this.finishRecord(records)
        continue
      }

      if (character === QUOTE && this.state === FIELD_START && this.field === '') {
        this.state = QUOTED
        this.fieldQuoted = true
        this.count(character)
        continue
      }

      // A quote inside an unquoted field, or text after a closing quote, is
      // literal content. Refusing the file over it would reject a great many
      // real exports for no gain.
      this.state = UNQUOTED
      this.consume(character)
    }
    return records
  }

  /** Finish. A record still inside quotes is reported, never guessed at. */
  end() {
    const records = []
    const unterminated = this.state === QUOTED
    if (unterminated) {
      const line = this.line
      this.fields = []
      this.field = ''
      this.raw = ''
      this.chars = 0
      this.state = FIELD_START
      return { records, unterminated: true, line }
    }
    if (this.open) this.finishRecord(records)
    return { records, unterminated: false, line: 0 }
  }
}

/** Read a whole CSV string. The same state machine, fed once. */
export function parseCsv(text, options = {}) {
  const reader = new CsvReader(options)
  const records = reader.push(text)
  const tail = reader.end()
  return {
    records: records.concat(tail.records),
    unterminated: tail.unterminated,
    unterminatedLine: tail.line,
    endings: reader.endings,
  }
}
