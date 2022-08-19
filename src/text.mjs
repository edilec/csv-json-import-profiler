/**
 * csv-json-import-profiler -- text handling shared by every reader.
 *
 * Nothing here touches the filesystem, the clock, the locale or the network.
 * Two properties in this module are the ones the rest of the tool leans on:
 *
 * 1. **Decoding is strict.** Bytes that are not UTF-8 are refused by the
 *    decoder, not inferred from decoded text afterwards. Hunting for U+FFFD
 *    cannot tell undecodable bytes from a file that legitimately contains a
 *    replacement character, and that confusion is how an unreadable input
 *    reports a pass.
 * 2. **Values are masked, identifiers are sanitised.** Import data is exactly
 *    where personal data lives, so no field value ever reaches the report as
 *    itself. `mask` keeps the shape and discards the content.
 */

import { Buffer } from 'node:buffer'

/**
 * Order by UTF-16 code unit.
 *
 * Not `localeCompare`, and not `Intl.Collator`: both depend on ICU data that
 * differs between Node builds, so the same input produces a different report on
 * a different machine. `S` (0x53) precedes `_` (0x5F) by code point while an
 * English collator treats the underscore as ignorable -- a real ordering
 * difference, pinned behaviourally in `test/determinism.test.mjs`.
 */
export function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * Characters removed from every untrusted string before it reaches output.
 *
 * Written as escapes rather than literally, because a literal U+2028 inside a
 * module is a hazard of its own. This applies to identifiers as well as
 * excerpts: a column name carrying U+0085 forges a report line just as well as
 * a field value does, and a file path is no safer than either.
 *
 * - `U+0000-U+001F` C0 and `U+007F` DEL -- a newline forges a report line and
 *   ESC opens a terminal escape sequence.
 * - `U+0080-U+009F` C1 -- `U+0085` NEL is a line break to a great many readers
 *   and `U+009B` is the 8-bit CSI, so it opens a control sequence with no ESC
 *   in sight.
 * - `U+2028` / `U+2029` -- line and paragraph separators.
 * - `U+200E`, `U+200F`, `U+202A-U+202E`, `U+2066-U+2069` -- the bidirectional
 *   controls. `U+202E` RIGHT-TO-LEFT OVERRIDE reverses everything displayed
 *   after it, so a rule id or a column name can be made to read as something
 *   else entirely while the bytes say otherwise.
 */
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u200E\u200F\u202A-\u202E\u2066-\u2069]/g

/** Replace every forgeable character with a space. */
export function sanitize(value) {
  return String(value).replace(CONTROL, ' ')
}

export const EXCERPT_LIMIT = 120

/** A bounded, single-line, sanitised excerpt. Used for names and messages. */
export function excerpt(value, limit = EXCERPT_LIMIT) {
  const flattened = sanitize(value).replace(/\s+/g, ' ').trim()
  const points = Array.from(flattened)
  if (points.length <= limit) return flattened
  return `${points.slice(0, limit).join('')}...`
}

export const MASK_LIMIT = 48

const DIGIT = /\p{Nd}/u
const UPPER = /\p{Lu}/u
const LOWER = /\p{Ll}/u
const LETTER = /\p{L}/u
// ASCII punctuation and symbols, which carry shape (an at sign, a dot, a
// hyphen) without carrying content.
const ASCII_PUNCT = /^[!-/:-@[-`{-~]$/

/**
 * Reduce a field value to its shape.
 *
 * A profiler reads other people's imports: names, addresses, card numbers,
 * medical codes. Quoting a value back as evidence would move that data into a
 * report, a log aggregator and a ticket. Every digit becomes `9`, every letter
 * becomes `A` or `a` (`x` for scripts without case), ASCII punctuation is kept
 * because it is the shape, and everything else becomes `x`.
 *
 * An address like `alice@example.com` masks to `aaaaa@aaaaaaa.aaa`: enough to
 * see a mail address where a number was expected, not enough to know whose.
 */
export function mask(value, limit = MASK_LIMIT) {
  const points = Array.from(sanitize(value).replace(/\s+/g, ' '))
  const shaped = []
  for (const point of points.slice(0, limit)) {
    if (point === ' ') shaped.push(' ')
    else if (DIGIT.test(point)) shaped.push('9')
    else if (ASCII_PUNCT.test(point)) shaped.push(point)
    else if (UPPER.test(point)) shaped.push('A')
    else if (LOWER.test(point)) shaped.push('a')
    else if (LETTER.test(point)) shaped.push('x')
    else shaped.push('x')
  }
  const body = shaped.join('')
  return points.length > limit ? `${body}...` : body
}

/**
 * A strict streaming UTF-8 decoder.
 *
 * `fatal: true` is the entire point, and `{ stream: true }` is what makes a
 * multi-byte character split across two chunks decode rather than fail. The
 * final `end()` flushes: a truncated sequence at end of file throws there, so a
 * file that stops mid-character is refused instead of silently shortened.
 */
export function createUtf8Decoder() {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
  return {
    push(bytes) {
      return decoder.decode(bytes, { stream: true })
    },
    end() {
      return decoder.decode()
    },
  }
}

/** Whether a byte sequence opens with the UTF-8 byte order mark. */
export function hasBom(bytes) {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
}

/** UTF-8 byte length of decoded text, for the row size limit. */
export function utf8Length(text) {
  return Buffer.byteLength(text, 'utf8')
}
