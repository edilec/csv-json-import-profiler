# Rules, limits and the report

This document is the reference for what `csv-json-import-profiler` reads, what each rule means, what
the report contains, and what the tool refuses to claim. Rule ids are stable: renaming one is a
breaking change and is recorded in the changelog.

## The three rules that are not negotiable

**Nothing is coerced.** A value is classified, never repaired. A column holding `42` and `forty-two`
is reported as mixed; `" 42"` is a string and the padding is reported separately. A profiler that
picked the popular type would describe a file nobody has, and the mixed column is the finding.

**Nothing is rewritten.** The input is opened read-only. There is no auto-fix, no normalisation pass
and no write path anywhere in `src/` — the module imports no write API at all. A profile goes to
stdout, or to `--out`, which refuses to be the input file — identity is the inode, because a hard
link is a second name for one file and resolves to a real path of its own — and refuses to replace
an existing file without `--overwrite`.

**No value reaches the report.** An import file is where personal data lives. Every sample is a
*redacted reference*: a record number, and a masked shape in which every digit is `9` and every
letter is `A` or `a`. `alice@example.com` is reported as `aaaaa@aaaaaaa.aaa` — enough to see a mail
address where a number was expected, not enough to know whose.

## What is read

The format is declared with `--format`, or inferred from the extension. It is never guessed from
content.

| Extension | Format |
| --- | --- |
| `.csv`, `.tsv` | `csv` |
| `.json` | `json` — one top-level array whose elements are the records |
| `.jsonl`, `.ndjson` | `jsonl` — one JSON value per line |

An extension outside this table with no `--format` is a configuration error: the run never had a
subject, so stdout stays empty and the message goes to stderr.

Bytes are decoded with `TextDecoder('utf-8', { fatal: true })`, streamed, so a multi-byte character
split across two reads decodes and a file that stops mid-character is refused. Whether bytes are
UTF-8 is the decoder's decision; the decoded text is never inspected to make that judgement, because
a file that legitimately contains U+FFFD is indistinguishable from a broken one once you start
looking at text.

The input is resolved to its real path and checked against the real root before it is opened. Both
sides of that comparison are real paths, so a symlink escaping the root is refused *and* a file
genuinely inside a root reached through a symlink is still profiled. A false refusal is a bug too.

### CSV framing

A streaming RFC 4180 state machine, not a `split` over newlines:

- a quoted field may contain the delimiter;
- a quoted field may contain CR, LF or CRLF, kept literally as part of the value;
- `""` inside a quoted field is one literal quote;
- CRLF, LF and a lone CR each end a record outside quotes.

Where real files leave the standard, the behaviour is chosen rather than accidental: a quote inside
an unquoted field is literal text, text after a closing quote is appended as literal text, and a
completely empty line is skipped rather than reported as a one-field record.

The first record is the header, and there is no headerless mode. Header names and JSON keys are
schema: they are sanitised but not masked, because a report that hid them would name nothing. The
consequence is worth stating plainly -- profiling a headerless CSV puts that file's first row into
the report as column names.

### JSON framing

For `json`, the top-level array is cut into records by a scanner that tracks string, escape and
nesting state, so a `,` or `]` inside a quoted value ends nothing. Each element is handed to
`JSON.parse` on its own, so memory is bounded by the largest record rather than by the file.

Before the parse, each record is scanned for **repeated object keys**. `JSON.parse` silently keeps
the last value for a repeated key, so a record carrying `"email"` twice loads with one of the two
values and no complaint anywhere. That question cannot be answered from the parsed object, which is
why the scan exists.

## The type vocabulary

| Type | Meaning |
| --- | --- |
| `integer` | `^[+-]?\d+$` |
| `number` | a decimal or exponent form that is not an integer |
| `boolean` | `true` / `false` / `TRUE` / `FALSE` / `True` / `False` |
| `date` | ISO-8601 date or date-time, validated against the calendar |
| `string` | anything else |
| `empty` | a quoted empty CSV field, or a JSON `""` |
| `null` | an unquoted empty CSV field, a configured null token, or JSON `null` |
| `structured` | a JSON object or array; it is not descended into for typing |

Types are grouped into **families**, and a column holding more than one family is the mixed-type
finding:

| Family | Types |
| --- | --- |
| `numeric` | `integer`, `number` |
| `boolean` | `boolean` |
| `date` | `date` |
| `text` | `string`, `empty` |
| `structured` | `structured` |

`integer` and `number` share a family deliberately: a column of `1` and `1.5` imports fine. `empty`
sits with `string` equally deliberately: a quoted empty field in a numeric column is exactly the
hazard this tool exists to name, because the importer asked for a number and received `""`.

An unquoted empty CSV field is a **null**; a quoted empty field is an **empty string**. Conflating
them is how a column reports "no nulls" while the load fails on a `NOT NULL` constraint.

## The rule catalog

| Rule | Severity | What it means |
| --- | --- | --- |
| `column-all-null` | warning | Every profiled record leaves this column null or absent, so the input carries no evidence of what it holds. |
| `column-integer-leading-zeros` | warning | Integer-looking values with leading zeros. Typed as a number they lose the zeros, and postcodes and part numbers never come back. |
| `column-integer-unsafe` | warning | Integers outside the exact range of a double, which any JSON or JavaScript importer will round. |
| `column-null-ratio-high` | warning | Nulls and absences above `--max-null-ratio`. |
| `column-type-mixed` | error | The column holds more than one type family. An importer typed from the first rows will reject the rest. |
| `column-value-padded` | warning | Values carry leading or trailing whitespace, which this profile counts as part of the value because an importer may keep it. |
| `duplicate-header-key` | error | A CSV header name appears twice. An importer keying by name keeps one column and drops the other silently. |
| `duplicate-object-key` | error | A JSON record sets the same key more than once. `JSON.parse` keeps the last value; every earlier one is lost without a diagnostic. |
| `header-column-unnamed` | warning | A header cell is empty, so nothing downstream can refer to that column by name. |
| `input-escapes-root` | error | The input resolves outside the declared root and was refused unread. |
| `input-has-bom` | warning | The file starts with a UTF-8 byte order mark. Importers that do not strip it read the first column name with an invisible character in front of it. |
| `input-mixed-line-endings` | warning | CRLF, LF and CR are mixed outside quoted fields. Readers that split on one of them produce records the others would not. |
| `input-not-an-array` | error | A `json` input whose top level is not one complete array: not an array at all, an array that never closes, or content after it. |
| `input-not-utf8` | error | The decoder refused the bytes. Nothing after the offending byte was read. |
| `input-too-large` | error | The `maxInputBytes` limit was reached, so the file was not read to the end. |
| `input-unreadable` | error | The path could not be opened, or is not a regular file. |
| `no-records-profiled` | warning | The run profiled nothing, so it checked nothing. This is the rule that makes `pass` with `checked: 0` unreachable. |
| `record-key-drift` | warning | A JSON record's key set differs from the first record's. Optional fields are legitimate; absent-by-mistake fields are not, and only you can tell them apart. |
| `record-not-an-object` | error | A record is a scalar or an array, so it carries no named fields to import. |
| `record-not-json` | error | A record did not parse, so nothing is known about it. |
| `record-too-deep` | error | A record nests past `maxDepth`. It was not parsed or profiled. |
| `row-field-count-drift` | error | A CSV row's field count differs from the header's. Its values cannot be attributed to columns, so they are not folded into the profile. |
| `row-too-large` | error | A record passed `maxRowBytes` and was not profiled. |
| `time-limit-exceeded` | error | Profiling passed `maxMillis`, so the rest of the input was not read. |
| `too-many-columns` | error | The input declares more columns than `maxColumns`. Profiling stopped. |
| `too-many-findings` | error | The report reached `maxFindings`, so later findings were not collected. |
| `too-many-records` | error | The input holds more records than `maxRecords`. Profiling stopped. |
| `unterminated-quoted-field` | error | A quoted CSV field is never closed, so the rest of the input is one record of unknown shape. |

Severity comes from one frozen `ruleId -> severity` table in `src/profile.mjs`. An unknown rule id
throws rather than defaulting to anything. That table is asserted against this catalog in both
directions — and, because three declarations that agree with each other can be edited together,
every severity that decides a verdict is *also* pinned by running the binary and asserting the exit
code in `test/severity-exit.test.mjs`.

## Limits

Every limit is explicit, overridable, and named in a finding when it is hit. Exceeding one produces
an `incomplete` report — never a silent truncation, and never a pass.

| Limit | Flag | Default | Rule raised |
| --- | --- | ---: | --- |
| `maxInputBytes` | `--max-input-bytes` | 8388608 | `input-too-large` |
| `maxRecords` | `--max-records` | 10000 | `too-many-records` |
| `maxRowBytes` | `--max-row-bytes` | 65536 | `row-too-large` |
| `maxColumns` | `--max-columns` | 256 | `too-many-columns` |
| `maxDepth` | `--max-depth` | 16 | `record-too-deep` |
| `maxFindings` | `--max-findings` | 1000 | `too-many-findings` |
| `maxMillis` | `--max-millis` | 10000 | `time-limit-exceeded` |

`maxRowBytes` is enforced twice: a character bound stops an unbounded record from accumulating in
memory — UTF-8 is never shorter than the UTF-16 length, so a record past the bound in characters is
past it in bytes — and a completed record is measured exactly in bytes. Either path raises the same
rule.

`maxMillis` is the one limit that may be zero. The budget is spent once the elapsed time *reaches*
it, so a budget of zero is spent before the first record. That is how the wiring between the CLI
flag and the clock is proven rather than assumed; the clock is injectable from the API, and no
elapsed time ever reaches the output.

An unknown limit name, a fractional limit, a limit below its floor and a `limits` that is present
but not an object all throw. Only an absent `limits` means "use the defaults": a misspelled limit
must not quietly leave the default in place.

## The report

The envelope is the catalog's report contract, with one documented extension: a top-level `profile`
key, because the profile *is* the output of a profiler and would not fit in an integer summary.

```json
{
  "schemaVersion": "1",
  "tool": "csv-json-import-profiler",
  "status": "pass",
  "summary": { "checked": 0, "errors": 0, "warnings": 0, "info": 0, "records": 0, "profiled": 0,
               "skipped": 0, "columns": 0, "driftedRecords": 0, "duplicateKeys": 0, "nulls": 0,
               "bytes": 0 },
  "profile": { "file": "orders.csv", "format": "csv", "records": 0, "profiled": 0, "columns": [] },
  "findings": []
}
```

- `checked` counts records that were examined. `profiled` counts the subset whose values could be
  attributed to columns — a drifted CSV row is checked and not profiled, because its values sit
  under the wrong names. `skipped` counts records that were found and not examined at all.
- `status` is `pass`, `fail` or `incomplete`. `incomplete` wins over both others: a run that failed
  to obtain evidence reports that, not a verdict.
- Each column entry carries `name`, `index`, `seen`, `absent`, `nulls`, `empty`, `padded`,
  `minLength`, `maxLength`, `families`, `types` and `samples`. Column order is the input's own
  order; only findings are sorted.
- A sample is `{ record, family, type, value }` where `value` is masked.

Findings sort by `(location.file, section, record, location.pointer, ruleId)`. `section` ranks
`input` before `columns` before `records`; `record` is compared numerically, so record 9 precedes
record 10; everything textual is compared by UTF-16 code unit. Ties keep insertion order, which
`Array.prototype.sort` has guaranteed to be stable since ES2019. Nothing in the output depends on
wall-clock time, locale, hash iteration or filesystem order, so two runs over the same bytes produce
byte-identical stdout.

## Sanitisation

Every untrusted string that reaches output — column names, JSON keys, file labels, messages,
evidence — has these removed and replaced with a space:

| Class | Range |
| --- | --- |
| C0 | `U+0000`–`U+001F` |
| DEL | `U+007F` |
| C1 | `U+0080`–`U+009F` |
| Line / paragraph separators | `U+2028`, `U+2029` |
| Bidi controls | `U+200E`, `U+200F`, `U+202A`–`U+202E`, `U+2066`–`U+2069` |

The C1 range matters as much as C0: `U+0085` (NEL) is a line break to a great many readers and
`U+009B` is the 8-bit CSI, which opens a terminal control sequence with no ESC in sight. `U+202E`
reverses everything displayed after it. An identifier is as dangerous as an excerpt here — a column
name carrying a newline forges a report line just as well as a field value does — so the strip is
applied at the one place findings are built, not at one field of them.

## Exit codes

| Code | Meaning | stdout |
| ---: | --- | --- |
| 0 | the input profiled cleanly | the report |
| 1 | the input was profiled and failed the check | the report |
| 2 | invalid usage or configuration | **empty** — the message is on stderr |
| 2 | evidence missing, undecodable or bounded out | an `incomplete` report |

A consumer piping stdout must handle an empty stdout on exit 2. A configuration error means the run
never had a subject, so there is nothing to report about; emitting a fake report for a run that
never started would be worse.

## What this cannot conclude

See the "Limits and non-goals" section of the README. In short: this tool reports what the file
says about itself. It cannot tell you whether a value is *correct*, whether a mixed column is a bug
or a deliberate union type, or anything at all about a record it could not read.
