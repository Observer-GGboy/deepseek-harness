# @deepseek-ai/dsh-session-import

English | [中文](README.zh.md)

Service Definition for safe foreign-session import. `SessionImportRegistry` owns `ctx.sessionImports`; Codex and Claude Code are separate Service Providers. The shared helpers recursively discover metadata without opening transcript bodies, reject symlinks, and stream one selected JSONL file under source, line, visible-byte, visible-message, and tool-count budgets.

The captured prefix is fixed at the initial file size. Appends after capture begins are ignored; replacement, truncation, middle mutation, malformed complete records, out-of-order timestamps, duplicates, and unsupported required shapes fail closed. A trailing incomplete record is ignored and reported. Provider output is a neutral immutable snapshot, never a `SessionEvent`.

Visible text is credential-redacted before it enters the snapshot. Hidden instructions, reasoning, tool arguments, tool results, attachments, environment values, and source transcript paths have no field in the neutral contract.

## Model Experience

### Imported historical context

#### What the model sees

Only redacted visible user/assistant text and an inert body-free tool-activity summary, after a Consumer converts a confirmed snapshot into native `SessionEvent` values.

#### Token effect

Imported visible text consumes context tokens on the first continued model request. Excluded records consume none.

#### KV Cache effect

The imported Session starts a new prompt prefix; it does not reuse the foreign product's cache identity.

## Known Limitations and Deferred Work

- JSONL is the only shared capture format; a future non-JSONL provider must implement equivalent stability and budget guarantees.
- Credential redaction covers common key and authorization shapes, not arbitrary secrets written as unconstrained prose.
- Provider compatibility is deliberately fail-closed; a new required vendor record shape needs an explicit parser update.
