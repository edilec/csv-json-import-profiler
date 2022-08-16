# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Added

- a streaming RFC 4180 CSV reader: a quoted field may contain the delimiter, may
  contain CR, LF or CRLF kept literally, and `""` inside quotes is one literal
  quote. A record straddling any number of chunk boundaries parses the same as
  one that does not;
- streaming JSON readers for a top-level array and for NDJSON, cutting the array
  into records with a scanner that tracks string and nesting state so a bracket
  or comma inside a quoted value ends nothing;
- a structural scan for repeated object keys, which `JSON.parse` resolves
  silently in favour of the last value and which cannot be asked of the parsed
  object;
- column profiling that never coerces: type families, nulls, quoted empties,
  padding, unsafe integers and leading zeros are counted and reported as they
  are;
- row shape drift for CSV (field count against the header) and key drift for
  JSON (key set against the first record), with the drifted record kept out of
  the column statistics because its values sit under the wrong names;
- encoding evidence: strict UTF-8 decoding, byte order mark detection and mixed
  line endings;
- redacted sample references -- a record number and a masked shape -- so no
  field value ever reaches the report;
- the report contract: envelope, one frozen `ruleId -> severity` table of 28
  rules, deterministic ordering by `(file, section, record, pointer, ruleId)`,
  and a top-level `profile` key documented as the one envelope extension;
- explicit limits on input bytes, records, row bytes, columns, JSON depth,
  findings and milliseconds, each named in a finding and each making the run
  `incomplete` rather than truncating silently;
- a CLI with `--input`, `--root`, `--format`, `--delimiter`, `--null-tokens`,
  `--max-null-ratio`, `--json`, `--out`, `--overwrite` and the limit flags, with
  exit codes 0 / 1 / 2 and both shapes of exit 2;
- `--out` refusals: never the input file, compared on real paths, and never over
  an existing file without `--overwrite`;
- clean and deliberately broken examples in all three formats;
- the rule catalog, type vocabulary, limits, report shape and sanitisation set
  in `docs/import-profile-rules.md`.

No release has been published.
