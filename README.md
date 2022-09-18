# csv-json-import-profiler

Stream a bounded CSV or JSON import and report what an importer would actually find in it: the type
families each column holds, how much of it is null, which records drift from the declared shape,
which object keys are set twice, and what the file's encoding and line endings are.

- **Repository:** [edilec/csv-json-import-profiler](https://github.com/edilec/csv-json-import-profiler)
- **Area:** Automation & Workflows
- **License:** MIT
- **Dependencies:** none. Node built-ins only, Node >= 22.

## Three properties that are not negotiable

**Nothing is coerced.** A column holding `42` and `forty-two` is reported as mixed, with both counts
intact. `" 42"` is a string and the padding is a finding of its own. A profiler that picked the
popular type would describe a file nobody has — and the mixed column *is* the finding, because it is
the thing that will stop the load at three in the morning.

**Nothing is rewritten.** The input is opened read-only. There is no auto-fix, no normalisation pass
and no write path anywhere in `src/` — the library imports `createReadStream`, `realpath` and `stat`
from the filesystem and nothing else. A profile goes to stdout, or to `--out`, which refuses to be
the input file (compared on the inode, so neither a symlink alias nor a hard link — which has no
target to resolve — can launder one into the other) and refuses to replace an existing file without
`--overwrite`.

**No value reaches the report.** An import file is where personal data lives. Every sample is a
*redacted reference*: a record number, and a masked shape in which every digit is `9` and every
letter is `A` or `a`. `alice@example.com` is reported as `aaaaa@aaaaaaa.aaa` — enough to see a mail
address where a number was expected, not enough to know whose.

## Install

```sh
npm install csv-json-import-profiler
```

Or run it from a checkout with no install at all:

```sh
node bin/csv-json-import-profiler.mjs --input examples/orders-clean.csv
```

## Use

```sh
csv-json-import-profiler --input orders.csv
csv-json-import-profiler --input orders.csv --json
csv-json-import-profiler --input export.txt --format csv --delimiter semicolon
csv-json-import-profiler --input catalog.json --out profile.json --max-records 500
```

The human summary goes to stdout; `--json` replaces it with the machine-readable report.
Diagnostics go to stderr, always.

```
orders-clean.csv (csv): 6 record(s) profiled, 0 error, 0 warning, 0 info, status pass.
records: 6 found, 6 attributed to columns, 0 not profiled, 0 shape drift, 0 duplicate key(s); 443 byte(s) read.
columns: 6; 1 null value(s). Values below are masked shapes, not data.
column                 families           nulls  length  sample
order_id               numeric            0/6    4-4     9999
placed_on              date               0/6    10-10   9999-99-99
customer_ref           text               0/6    9-9     AAAA-9999
quantity               numeric            0/6    1-2     9
unit_price             numeric            0/6    4-5     99.99
notes                  text               1/6    29-41   Aaaaa aa aaa aaaa, aaaa aaa aaaa
```

The deliberately broken example shows what a finding looks like — a record number and a shape, never
the record:

```
ERROR   orders-broken.csv/columns/unit_price column-type-mixed Column "unit_price" holds 2 type
        families (numeric, text); an importer that typed the column from its first rows will reject
        the rest. No value was coerced to produce this profile. -- record 1 numeric/number 99.99 |
        record 2 text/string aaaaaaaa
ERROR   orders-broken.csv:4/records/3 row-field-count-drift Record 3 has 8 field(s) where the header
        declares 7; its values cannot be attributed to columns, so they are not in this profile.
        -- 9999,9999-99-99,AAAA-9999,999,9.99,Aaaaa aa aa a...
```

Try all five examples:

```sh
node bin/csv-json-import-profiler.mjs --input examples/orders-clean.csv      # exits 0
node bin/csv-json-import-profiler.mjs --input examples/orders-broken.csv     # exits 1
node bin/csv-json-import-profiler.mjs --input examples/catalog-clean.json    # exits 0
node bin/csv-json-import-profiler.mjs --input examples/catalog-broken.json   # exits 1
node bin/csv-json-import-profiler.mjs --input examples/events-clean.jsonl    # exits 0
```

## What it reads

| Format | Shape | Inferred from |
| --- | --- | --- |
| `csv` | RFC 4180, first record is the header | `.csv`, `.tsv` |
| `json` | one top-level array of records | `.json` |
| `jsonl` | one JSON value per line (NDJSON) | `.jsonl`, `.ndjson` |

Extension matching is case-insensitive, so `.CSV` and `.NDJSON` infer the same formats as their
lowercase spellings. Anything else must be declared with `--format`.

The CSV reader is a streaming state machine, not a split on newlines: a quoted field may contain the
delimiter, may contain CR, LF or CRLF kept literally, and `""` inside quotes is one literal quote.
A record straddling any number of chunk boundaries parses the same as one that does not.

The JSON reader cuts the top-level array into records with a scanner that tracks string and nesting
state, so a `]` or `,` inside a quoted value ends nothing, and hands one element at a time to
`JSON.parse`. Before the parse it scans each record for **repeated object keys** — `JSON.parse`
silently keeps the last value for a repeated key, so `"email"` twice loads with one of the two values
and no complaint anywhere. That question cannot be answered from the parsed object.

## API

```js
import { profileFile, profileText, profileBytes, formatReport } from 'csv-json-import-profiler'

const report = await profileFile({ input: 'orders.csv', root: 'inbox' })
console.log(formatReport(report))

// Or profile content that does not live on disk. No filesystem access.
const inMemory = await profileText(csv, { file: 'orders.csv', format: 'csv' })
const fromBytes = await profileBytes(bytes, { file: 'orders.csv', format: 'csv' })
```

An unknown option key, an unknown limit name, an unrecognised format, an out-of-range null ratio and
a `limits` that is present but not an object all throw rather than being ignored. Only an absent
`limits` means "use the defaults" — a misspelled limit must not quietly leave the default in place.

## Exit codes

| Code | Meaning | stdout |
| ---: | --- | --- |
| 0 | the input profiled cleanly | the report |
| 1 | the input was profiled and failed the check | the report |
| 2 | invalid usage or configuration | **empty** — the message is on stderr |
| 2 | evidence missing, undecodable or bounded out | an `incomplete` report |

A consumer piping stdout must handle an empty stdout on exit 2. A configuration error means the run
never had a subject, so there is nothing to report about; emitting a fake report for a run that never
started would be worse.

## Guarantees, each with a test that fails when it is removed

- **No value from the input appears in the report.** Values written into a fixture are searched for
  in the report produced from it, in both renderings.
  That includes the error path: a record that does not parse is named and located, never quoted,
  because V8 puts the record itself inside its own parse error message.
- **A mixed column is reported, never coerced**, and both type counts survive into the profile.
- **A quoted multiline field is one record with one value**, and a record whose field count differs
  from the header is reported and kept out of the column statistics, because its values sit under the
  wrong names.
- **The input is never rewritten.** Bytes and modification time are compared before and after runs
  over six inputs — clean and broken, through the library and through the binary with `--out`.
- **`pass` with `checked: 0` is unreachable.** A run that profiled no record is `incomplete`.
- **Every limit is enforced where it is documented**, tested on the bound itself and one step past
  it — one byte, one column, one level — and exceeding one is an explicit finding with an
  `incomplete` report, never a silent truncation.
- **Every `incomplete` flag that can change an answer is load bearing.** Eight of the twelve were
  deleted in turn and a test failed for each, on inputs that profiled records first so the empty-run
  guard was not what caught it. The other four sit on paths that end with `checked === 0`, where
  `finalize()` reaches the same verdict anyway: an input refused for escaping the root, an input
  that could not be opened, a read that fails part way through, and a header row past
  `maxRowBytes`, which stops profiling before any record exists. Each was measured rather than
  assumed — turning the header flag off still reports `incomplete` and exits 2. They are kept as
  defence in depth, not pinned, because no input can make their removal observable.
- **Every finding's severity comes from one frozen table.** An unknown rule id throws rather than
  defaulting to anything. Because declarations that agree with each other can be edited together,
  every severity that decides a verdict is pinned by running the binary and asserting the exit code.
- **Every untrusted string reaching output is sanitised** — column names, JSON keys, file labels,
  messages, evidence and the arguments quoted back in a CLI diagnostic, not only `evidence`. C0, DEL, the C1 range (`U+0085` NEL and `U+009B` CSI
  included), `U+2028`, `U+2029` and the bidi overrides are removed, so nothing read can forge a
  report line or reverse one.
- **Output is deterministic.** No wall clock in the output, no locale, no `localeCompare`, no
  `Intl.Collator`, no random source, no network. Every sort over text the input supplies is pinned
  by an emitted string whose collation order differs from its code-unit order, not by grepping the
  source; the sorts over closed vocabularies — rule ids, family and type names — are pinned by
  enumerating all 832 ordered pairs and asserting that a collator would order them identically.
- **Containment is decided on real paths, both sides.** A symlink escaping the root is refused
  unread; a sibling directory whose name merely starts with the root's (`inbox-archive` beside
  `inbox`) is outside it; a file genuinely inside a symlinked root is still profiled, because a
  false refusal is a bug too.

## Limits and non-goals

This tool reports what a file says about itself. It cannot tell you:

- **Whether a value is correct.** A perfectly typed column of wrong numbers profiles as clean. This
  is a shape report, not a validation of meaning.
- **Whether a mixed column is a bug.** Some columns are deliberately a union type. The tool says the
  column will not load under a single type; whether that is intended is a decision it cannot make,
  which is why the rule is reported rather than repaired.
- **Whether a key that drifts is optional or missing by mistake.** Both look identical in the data.
- **What the file means.** Column names are echoed, never interpreted: nothing here knows that
  `dob` is a date of birth or that `amount` is money.
- **Anything about a record it could not read.** A record that is too large, too deep, not JSON, or
  bounded out by a limit makes the run `incomplete`. Unknown is never reported as a pass.
- **Whether your importer will accept the file.** It reports the hazards it can see in the bytes; an
  importer has its own rules, its own type mapping and its own null handling.
- **Whether a masked sample is safe to share.** Masking removes content, not context: a column named
  `patient_nhs_number` says something even when every value is `999 999 9999`. Column names and JSON
  keys are schema, so they are sanitised but *not* masked — which also means that pointing this tool
  at a **headerless** CSV puts that file's first row into the report as column names. There is no
  headerless mode, and this is the reason to care about that.
- **Whether an encoding is right.** It decodes strictly as UTF-8 and refuses anything else rather
  than guessing. A Latin-1 export is reported as not UTF-8; it is not transcoded.

Deliberately narrow, so the report means one thing:

- there is no headerless CSV mode — the first record is the header;
- the type vocabulary is fixed (see [`docs/import-profile-rules.md`](./docs/import-profile-rules.md));
  currency symbols, thousands separators and local date formats are `string`, which is what they are
  to an importer expecting a number or a date;
- nested JSON is reported as `structured` and not descended into for typing, though depth is bounded
  and repeated keys are found at every level;
- line-ending reporting is CSV-only, because only the CSV reader knows which newlines are content;
- there is no sampling mode: the tool reads until a limit stops it, and says which limit that was.

## Development

```sh
npm run check     # lint, test, run the example, and verify the package contents
npm test
npm run test:coverage
```

Zero runtime and zero development dependencies. `node --test` and `node --check` only.

Full rule catalog, type vocabulary, limits, report shape and determinism guarantees:
[`docs/import-profile-rules.md`](./docs/import-profile-rules.md).

## License

MIT. See [LICENSE](./LICENSE).
