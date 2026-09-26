# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Fixed

- `--out` accepted a destination that destroyed a file the tool was never asked
  to touch. The check resolved the destination and compared the result with the
  input, which caught a symbolic link pointing AT the input and a hard link to
  it, and missed the case that actually loses data: a symbolic link pointing
  anywhere else. `realpath` resolved it, the resolved path was not the input,
  and the write went through the link. Measured with `--overwrite` -- the flag
  whose whole purpose is to say "replace that file" -- a 9-byte file outside
  the tree became a 3460-byte profile at exit 0. A link whose target did not
  exist yet needed no `--overwrite` at all: the profile was created outside the
  tree. A symlinked parent directory did the same thing one level up.
  `assertWritableDestination` now refuses all three before the input is opened,
  and the hard-link identity comparison lives inside the same guard.
  `test/destination.test.mjs` has one case per hole and one per allowed shape.

### Added

- `--out-root`, declaring the tree `--out` may resolve inside. It defaults to
  the working directory and has no meaning without `--out`; `--overwrite`
  without `--out` is now a usage error too, rather than a flag with no effect;
- `assertWritableDestination` and `DestinationError`, exported for a caller
  writing its own destination logic;

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
- `--out` refusals: never the input file -- identity is the inode, so neither a
  symbolic link nor a hard link is a way round it -- and never over an existing
  file without `--overwrite`;
- clean and deliberately broken examples in all three formats;
- the rule catalog, type vocabulary, limits, report shape and sanitisation set
  in `docs/import-profile-rules.md`.

No release has been published.
