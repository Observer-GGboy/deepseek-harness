# Agent Note: Collision-safe credential references in Models settings

Status: implemented

English | [中文](2026-08-14-credential-reference-collision.zh.md)

## Problem

The Models page derived `<ROUTE>_API_KEY` whenever a pi-ai profile did not yet name `apiKeyEnv`. Provider route ids are local to their adapter/settings namespace, but credential references are global. A pi-ai route named `deepseek` therefore derived `DEEPSEEK_API_KEY`, the same fixed reference used by the official DeepSeek profile. Saving a new gateway key silently replaced the credential observed by both routes. The reverse edit and deletion had the same ownership ambiguity: a row could overwrite or remove a credential still used by another provider. The browser never received secret values, but its value-free join did not preserve enough reference ownership to prevent destructive writes. This decision partially supersedes the single-row cleanup proof in the [provider credential lifecycle note](2026-08-06-provider-credential-lifecycle.md); that note remains authoritative for staged writes, retries, blank-key behavior, and provider identity.

## Decision

The joined provider rows now project a secret-free credential-reference ledger containing only provider identity, settings namespace/path, and reference name. Before any editor or custom-provider credential write, the page excludes the target's own profile and checks whether another profile names the proposed reference.

A collision renders a native radio group. Its safe default writes a route-private reference derived from namespace plus route (`DSH_<NAMESPACE>_<ROUTE>_API_KEY`, with a numeric suffix if needed) and records that reference through the profile's `apiKeyEnv` path. The alternative explicitly shares the existing reference and states that the new key replaces it for every listed provider. A sharing choice is scoped to the exact reference-and-owner collision; pushed settings changes cannot carry that intent to a different target. If a profile write succeeds but credential storage fails, retries keep the already-committed reference and retry only `credentials.set`.

Credential cleanup follows the same ledger. A row may remove a credential only when the reference matches one of the page's deterministic naming schemes, is writable/configured, and has no other profile user. Shared, environment, arbitrary custom, and otherwise unidentifiable references remain in place. At every stage, settings ops, UI copy, logs, tests, and snapshots contain reference names at most; the credential value remains write-only in the `credentials.set` call.

## Alternatives considered

**Reject every collision.** Rejected: intentional credential sharing is useful for aliases and gateway routes, and the page can make that action explicit without forbidding it.

**Always create a new reference without showing a choice.** Rejected: this prevents accidental replacement but makes existing intentional sharing impossible to preserve from the UI.

**Key references only by provider route id.** Rejected: route ids are adapter-local, which is the mismatch that created the collision. Namespace plus route provides a stable, user-readable independent name.

**Read or compare credential values to infer sharing.** Rejected: the credential plane is deliberately write-only. Reference ownership can be decided entirely from redacted settings metadata, so secret material must not enter the browser or diagnostic surfaces.

## Consequences

Saving a pi-ai `deepseek` route no longer changes official DeepSeek by default, and either route can be separated from an existing shared reference. Users can still choose sharing with an explicit, localized warning. Onboarding may now write one `apiKeyEnv` settings op before its secret write when official DeepSeek needs an independent reference; without a collision its behavior is unchanged. The reference ledger is recomputed from each pushed/refetched snapshot, so cross-tab settings changes converge without caching secret state. Deterministic names are longer than the legacy route-only form, and a profile that intentionally shares a credential now requires one additional choice when replacing it.
