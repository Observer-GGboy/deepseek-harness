# @deepseek-ai/dsh-client-ui-session-import

English | [中文](README.zh.md)

Web Settings Consumer for local Codex and Claude Code Session import. The section makes source kind and discovery explicit, lists metadata only, captures one selected source, previews counts and the optional cwd hint, and requires confirmation of the Workspace, Agent preset, and exact continuation model before commit. Each model choice shows its Host-computed safe import-token allowance.

The UI never receives or renders message text, tool arguments/results, source transcript paths, file identities, credentials, or reservation contents. Capture and commit use `AbortSignal`; changing source or leaving the page discards an uncommitted reservation. The v1 progress contract deliberately reports only bounded local phases—finding, reading/validating, and atomic publication—and exposes no unverified byte counters. After publication, the Client refreshes the Session list and opens the deterministic imported Session.

## Model Experience

### Human-confirmed import

#### What the model sees

The UI itself adds no model content. Its confirmed Host commit creates the sanitized historical context described by `dsh-session-import-local`.

#### Token effect

No token effect before commit. Before publication, the Host measures the complete imported seed together with the selected preset's assembled system prompt and tools against the selected model's safe allowance. The retained context counts on the next model request.

#### KV Cache effect

No direct effect from rendering Settings; the imported native Session starts its own prefix.

## Known Limitations and Deferred Work

- Discovery reads the filesystem of the DeepSeek Harness Host, which may differ from the browser device on a remote deployment.
- The preview intentionally shows counts and metadata, not transcript excerpts.
- If post-publication Workspace accounting fails, Settings remains open with a warning while the complete Session is selected and usable.
