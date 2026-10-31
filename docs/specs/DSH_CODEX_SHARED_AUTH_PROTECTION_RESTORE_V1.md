---
spec_id: DSH_CODEX_SHARED_AUTH_PROTECTION_RESTORE_V1
status: accepted
date: 2026-10-31
repository: Yan-Zero/dsh-codex
implementation_authority: contracts
production_apply_authority: none
donor_revision: 75d98d5b10bb926d53108e49019668c1bde2a9eb
main_base: 413c651e07820f2a4670049c8087077f074fa846
release_base: e3e54e206f7c829503c7e6eed378643ba0416792
acceptance_actor: 'supervisor (Owner retained authority: semantic/identity class, 2026-10-31)'
accepted_date: '2026-10-31'
---

# Shared-auth protection restoration — proposed external implementation authority

This is a proposed Spec for independent acceptance in the plugin repository.
The current user brief requests restoration, but this document does not label
that brief, its own proposal, or a review as Spec acceptance. No code may be
implemented from this proposal until the acceptance transaction is recorded.

## Evidence and intent

The accepted Agent Core `AGENT_CORE_FLEET_SHARED_CODEX_AUTH_V3` at
`0386b34a3d1054c71cbe51a2310fdff4d55c992b` requires separate accepted plugin
authority (§3 L208–219). Its CTR-SCA-001–010 still require canonical identity,
cross-process locking, durable intent, fail-closed unknown outcome and explicit
Owner reauth. These obligations are carried forward, not declared obsolete.

The actual 0.2.3 release has SHA-256
`869b8e64095a796a0fe6cfbe7bc09e5cf49dfa35defba7b69d621cfec0d0290f`;
its store/service/index source exactly matches donor revision above.
The rejected native 0.2.5 release has SHA-256
`cf22a2f0d64037fa3f710f3f590f595ef8e200bad06f3fc0028e71e54b80b4f3`.
The complete investigation is `/tmp/025-compat-report/REPORT.md`.

Current remote main is 0.3.2, not 0.2.5. Its credentialFile transport is present,
but shared updates use process-local serialization, have no durable intent, and
do not enforce every path component or private-parent boundary. New document
formats and provider-conflict checks do not substitute for the V3 protocol.

## Proposed execution scope and exact bases

To satisfy both “main plugin source” and “0.2.5-r2”, use two explicit branches:

1. Restore main based on exact `main_base` above. Keep package version 0.3.2;
   do not relabel its unrelated features as 0.2.5.
2. Produce the 0.2.5-r2 release from exact `release_base` above, carrying the
   same three protection contracts and direct tests, without importing later
   main features/dependencies. Set the candidate package version honestly to
   `0.2.5-r2`, with distinct source commit and artifact hashes.

This proposed dual-branch scope awaits Owner acceptance; acceptance of this
exact proposal selects both branches. If only one
branch is selected, amend this proposal before acceptance so the unselected
work cannot be implied. Acceptance must bind the exact reviewed Spec commit,
selected bases, actor and time. Implementation must not edit its governing Spec.

## Restoration contracts

Decisions: one canonical filename/lock/intent authority remains required;
none of the three protection groups is obsolete; preserve main's established
document and front-door behavior while restoring the missing protocol; use a
separate native-0.2.5 branch for the r2 artifact. These are bounded decisions
for this plugin derivative, not amendments of Core's production contracts.

### R1 — Canonical configuration, identity and permissions

Retain or restore optional credentialFile in Config/schema/apply/service/store.
Outside explicitly configured shared mode, preserve the DSH_HOME default.
Inside shared mode require an absolute path, no symlink in any component,
single-link regular credential/intent files, private parent directory and
owner-only modes. Never fallback to a per-home store. Keep credentialFile out
of volatile preference/settings descriptors. Test the real Loader/apply chain.

### R2 — Refresh intent and cross-process coordination

Port donor canonical-filename writer locking, lock-internal reread and pending
inspection. Before a refresh callback can dispatch, durably publish the exact
V3 pending intent (version, non-secret device/inode generationId, pending state,
RFC3339 startedAt), fsync file and parent directory. Atomic credential commit
must be followed by file/parent durability, then durable intent removal.
Existing pending intent cannot be overwritten by automatic refresh. Waiters
must reread or wait without another provider call; bounded exhaustion exposes
the stable OPENAI_CODEX_REFRESH_IN_PROGRESS discriminant.

For main preserve decodeCredentialDocument/update, idToken/email and unrelated
provider fields, concurrent-edit detection, proxy arguments, policy/settings
and usage-cache behavior. Process-local serialization alone is insufficient.
Do not overwrite donor files wholesale over main.

### R3 — Unknown outcome, error identity and explicit Owner recovery

Same-generation pending intent fails closed before read/use/refresh, forbids
old-token reuse and surfaces stable redacted OPENAI_CODEX_REAUTH_REQUIRED.
Replacement-generation recovery validates credential document and permissions
before controlled intent clearing, with no refresh. Invalid replacement keeps
evidence. Lock age alone never permits orphan deletion.

Port donor explicit Owner reauth scope around authorized interactive login;
automatic refresh cannot enter that scope. Audit actual service/Web/CLI login
call paths: donor service-only coverage must not be represented as universal
front-door recovery. Add scope to the common explicit login seam if required,
with direct tests, and preserve cancellation/proxy/cache behavior.

Retain donor public error exports. Resolve the newer usage.ts class name
collision so store, usage predicate and root exports recognize the same
reauth condition without deleting existing HTTP 401/403 behavior. Test actual
store errors through consumer entrypoints, not only fabricated exceptions.

## Allowed change surfaces and exclusions

Primary files: src/store.ts, src/service.ts, src/index.ts and direct tests,
including donor tests/service-config.spec.ts, tests/shared-store.spec.ts and
tests/fixtures/shared-refresh-worker.ts. src/usage.ts and src/auth.ts or the
actual interactive-auth entrypoint may change only as directly necessary for
R3 error identity/Owner scope. A tiny common error module is allowed if needed
to avoid circular imports. Package version metadata may change only on release
branch; lock data may change only if mechanically required by that metadata.

No new OAuth refresh client, token format, model/route/fallback policy, session
event, dependency version upgrade or unrelated feature is authorized here.
Main retains its existing architecture; retaining it is not a V3 conformance
ruling on its newer provider refresh or document formats. All production pin,
config, credential, artifact-store, runtime and fleet operations remain excluded.

## Acceptance evidence required after implementation

- RED→GREEN for native 0.2.5 missing configuration/intent/crash protections;
  main regressions exercise real new formats/settings/proxy/cache composition.
- Donor local synthetic 10/20/50-process bursts and slow writer verify one remote
  fixture call per generation; no external OAuth/provider requests.
- Crash before dispatch, post-rotation/pre-write and post-write/pre-clear;
  callback/write failure; invalid replacement; one explicit Owner recovery;
  relative/component-symlink/hardlink/private-parent tests and error redaction.
- Full plugin test command, typecheck and build on each implemented branch.
  Report every failure and pre-existing limitation; do not hide donor gaps.
- Rebuild four distinct 0.2.5-r2 artifacts: release tgz, dependency-scopes tgz,
  source-stamp JSON, build-attestation JSON, each with SHA-256 sidecar. Freeze
  exact source commit/tree and lock/toolchain/build commands. Generic stamp
  shape stays version/sourceCommit/artifactSha256; additional data goes into
  attestation. Scopes must byte-match embedded dependencies.
- Rerun full file/hunk comparison against the exact original 0.2.3 artifact
  using the existing report scripts adapted to candidate paths. Track all
  original protection hunks, donor equivalence and justified main adaptations;
  classify remaining non-protection deltas separately. RESTORED needs executable
  evidence; OBSOLETE needs accepted architecture/V3 replacement evidence.
- A fresh non-author reviews source diff, Spec compliance, tests, archive bytes,
  dependency graph, stamp/hashes and differential coverage, recording exact SHAs.

| Acceptance | Contracts | Method and environment | Required evidence | Expected result / failure condition |
|---|---|---|---|---|
| A1 | R1 | Real Config/Loader/apply/service and filesystem tests in isolated temporary homes on both branches | RED→GREEN logs, source SHA, filename readback; component symlink, hardlink, relative, parent-mode negative cases | Explicit canonical path survives every carrier; defaults only outside shared mode; any fallback or accepted unsafe path fails |
| A2 | R2 | Donor subprocess synthetic refresh/crash fixture, 10/20/50 processes and slow owner; no real provider | Full logs, fixture call count, non-secret intent and inode/mode observations, implementation/source SHA | At most one synthetic refresh per generation; durable-before-callback intent; correct clear after commit; second dispatch or missing durability fails |
| A3 | R3 | Crash at each donor boundary; callback/write failure; invalid replacement; explicit Owner recovery and consumer error tests | Logs of no retry callbacks, preserved pending evidence, reauth/error identity, scope and redaction assertions | Unknown state cannot read/use/retry old generation; valid replacement recovers without refresh; unscoped bypass, lost intent or token-bearing errors fail |
| A4 | R1/R2/R3 | Full plugin test/typecheck/build and exact-artifact static comparison in isolated local assemblies | Both branch commits; complete test results; four artifacts/sidecars; file/hunk matrix; non-author review | All applicable checks pass or failures remain explicit blockers; missing coverage, fake hashes, hidden later features or rollout claims fail |

Rejected alternatives: automatic retry after unknown rotation, per-home writable
fallback/copies/link/sync, treating process-local serialization as a cross-process
lock, and relabelling all 0.3.2 main features as a pure 0.2.5-r2 restoration.
Migration/rollback: this task installs nothing and retains all original artifacts;
no credential/session migration or runtime rollback is authorized. Any future
adoption must separately establish reader/rollback compatibility and Owner apply.

Completion of these checks means a local restoration candidate was delivered.
It does not amend Agent Core V3's 0.2.3 compatibility pin, establish full V3
compatibility, production admission, rollout permission or runtime acceptance.


## Acceptance transaction (2026-10-31)

Accepted by supervisor under Owner retained authorities (semantic/identity class) after non-author review (30/30 static identity checks, INDEPENDENT_REVIEW.md). Basis: the three protection groups (canonical config passthrough, refresh-intent, unknown-outcome fail-closed) are REQUIRED — V3 CTR-SCA-001-010 obligations carried forward; donor revision 75d98d5b is the production-proven 0.2.3 lineage. Implementation proceeds per IMPLEMENTATION_PLAN.md (0.3.2 main fix + 0.2.5-r2 backport), zero production writes until rollout admission.
