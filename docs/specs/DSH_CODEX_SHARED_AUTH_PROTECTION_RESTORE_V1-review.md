# Independent review — proposed authority and unimplemented delivery

Reviewed at 2026-10-31T06:33:23.605256+00:00. Reviewer: `/root/authority_review`; author of the proposal/report: root and separate group-audit authors. This reviewer did not author the proposed Spec, implementation plan, report, canonical audit, or intent/outcome audit. The packaged `evidence/authority-review.md` is this reviewer's earlier read-only audit; it is identified as such and is not presented as a second independent product review.

**Verdict: suitable for Owner consideration as a proposed, bounded source/build authority and an honest incomplete-delivery checkpoint. No material document/evidence finding remains open after the bounded corrections below.** This recommendation is neither Spec acceptance nor permission to implement. The requested restoration, four artifacts, candidate diff and product conformance remain unfinished.

## Exact review coordinates and scope

- Plugin proposal branch: `proposal/shared-auth-protection-restore-20261031`.
- Reviewed proposal commit: `fe78b0aaae3114285223f784f0ee5cb57ef8d715`.
- Proposal base/current observed upstream main: `413c651e07820f2a4670049c8087077f074fa846`.
- Independent `git diff --name-status BASE HEAD` shows exactly one added file: `docs/specs/DSH_CODEX_SHARED_AUTH_PROTECTION_RESTORE_V1.md`; 167 lines. Plugin worktree is clean.
- The delivery proposal copy is byte-identical to that exact committed file, SHA-256 `e99ab78adb0c6fb37d51f64a9f79e921ff30c73d35861b0d292da8bbf53a13b4`.
- Evidence/report/plan were reviewed at the exact hashes below. Core evidence commit and subsequent `DELIVERY.json` are outside this review's present coordinates; their final receipt must bind actual commits without pretending they were already reviewed here.
- Scope is the named proposal/preflight/plan/evidence documents and their source support. **No implemented code, r2 archive, dependency-scopes archive, source stamp, build attestation, runtime, credentials or fleet operation was reviewed or executed.**

## Findings and closure

The first review consolidated two document corrections. A subsequently added receipt introduced one bounded provenance correction. All are closed in the final hashes recorded below; no unrelated product requirement was added.

| ID | Initial issue | Minimal correction and final delta result |
|---|---|---|
| D1 | `canonical-audit.md` authority-limitation paragraph said candidate source/build could proceed under the task, conflicting with this packet's pause before implementation. | Final L71 allows only read-only investigation/proposal preparation and explicitly defers source edits and changed-candidate assembly until applicable external accepted authority. **CLOSED.** |
| D2 | The same audit inferred that the current main test's no-lock expectation necessarily conflicts with cross-process locks. | Directly inspected `413c651:tests/store.spec.ts:99-108`: the actual assertion only checks no lock remains after completion. Final L63 correctly distinguishes that cleanup assertion from during-callback lock coverage. **CLOSED.** |
| D3 | Newly added remote search JSON initially contained only zero results, with no reconstructible query/repository/time coordinates for the report's limited remote-search claim. | Final receipt records exact query, both repositories, GET endpoint, command, request/receive timestamps, exit code, complete-result flag and indexed-search limitation. Report continues to disclaim universal absence. **CLOSED.** |

The historical evidence files remain readable as prior observations; the final report and draft control the proposed route. There is no new authority-acceptance claim or product PASS hidden in the correction cycle.

## Review conclusions

1. **Authority gap is correctly scoped.** User AGENTS and its old checkout grammar require accepted governing scope before non-trivial implementation. Current Core grammar separately distinguishes a task mandate from Product Authority. Accepted V3 L208-219 explicitly reserves plugin code authority to the external repository; CTR-SCA-013 and ACC-SCA-011 also constrain the implementation/candidate identity to the historical 0.2.3 line. The report correctly separates that gap from production apply gates and preserves `NOT_FOUND_IN_INSPECTED_LOCAL_SURFACES`. It permits an exact existing applicable authority to close the gap rather than insisting another Spec must always be invented.
2. **The three groups remain required; current-main transport is not falsely reported absent.** Direct source inspection supports the table: native 0.2.5 lacks the donor config/intent/recovery surfaces; main 0.3.2 restores credentialFile transport but uses process-local coordination on explicit shared files and no durable refresh intent. Its usage HTTP reauth class does not supply persistent crash/generation authority. Main's incomplete component-symlink/private-parent checks are correctly distinguished from final-file checks. The report uses `RESTORE_REQUIRED`, never `RESTORED` or `OBSOLETE`.
3. **Modern behavior and version provenance are preserved.** The draft explicitly selects two proposed branches on acceptance: main `413c651...` stays version 0.3.2 and retains modern document/provider/proxy/settings/cache behavior; r2 is a separate backport from `e3e54e2...` with honest `0.2.5-r2` identity. It does not call a main-derived tree a pure 0.2.5 repair. Owner selection of one branch requires an amended proposal first. No Core production pin is changed or implicitly reaccepted.
4. **The proposed restoration is bounded and testable.** R1-R3 specify path/config identity, filename serialization/durable intent, unknown-result fencing, error identity and explicit interactive Owner recovery. A1-A4 map each obligation to isolated execution methods, required evidence and concrete failure conditions. Allowed files are limited to those seams and directly necessary error/auth entrypoints; feature/dependency/route changes and production operations remain excluded. Real login front-door coverage and the newer error-class collision are explicitly left for implementation/tests rather than assumed donor-complete.
5. **The plan does not self-authorize.** It starts only after accepted external scope is bound, uses isolated bases and synthetic providers, preserves original artifacts, calls for both-branch test/build evidence, then the four-artifact release and full differential report. It preserves non-protection deltas and separate full-compatibility/rollout adjudication. No production runbook or new Core production Spec is demanded merely to author a local candidate.
6. **Completion status is honest.** Current result is source audit plus proposed authority and plan. `NOT_STARTED`, `NOT_BUILT`, `NOT_RUN` and `NOT_ASSESSED` are consistent across the report and preflight. No executed RED/GREEN, product test PASS, candidate hash, four-artifact delivery, implementation review, V3 conformance or runtime acceptance is claimed.

## Executed verification

Independently recomputed **30/30 static identity checks**, all matching the supplied source-verification record:

- 21 file-byte/hash comparisons from `git show` across donor/native-0.2.5/current-main.
- Three package-version readbacks.
- Two original release archive SHA-256/size readbacks (ordinary artifact reads; no plugin import).
- Three donor source-snapshot-to-Git byte bindings.
- One accepted Spec snapshot hash.

Also directly inspected main store/auth/usage and the disputed test assertion, the proposed-commit file manifest/clean status, proposal copy equality, and final receipt/statement deltas. Upstream PR15's fetched body agrees with source: the newer shared-file implementation expressly replaced the original fleet intent/Owner protocol and disclaims cross-program exactly-once/crash guarantees. It is evidence of changed upstream behavior, not acceptance of a Core V3 replacement. The zero-hit search remains bounded indexed exact-name evidence; it cannot establish universal authority absence.

No product test/build/diff command, plugin import, OAuth/provider call, credential read or production mutation was performed by this review.

```text
SPEC_GOVERNANCE_MODE = REVIEW
REVIEW_KIND = SPEC (proposed authority and evidence checkpoint only)
SPEC_REVIEW = ACCEPT (recommendation for Owner consideration; not acceptance transaction)
REVIEW_TARGET_HEAD = fe78b0aaae3114285223f784f0ee5cb57ef8d715
BASE_HEAD = 413c651e07820f2a4670049c8087077f074fa846
CURRENT_BASE_HEAD = 413c651e07820f2a4670049c8087077f074fa846
AUTHOR_INDEPENDENCE = PASS_FOR_NAMED_PROPOSAL_AND_PARENT_DOCUMENTS
AUTHORITY_REVIEW = PASS_FOR_GAP_AND_PROPOSAL_BOUNDARY
EVIDENCE_REVIEWABILITY = PASS_FOR_REVIEWED_SCOPE
REVIEW_SCOPE = FULL_INITIAL_DOCUMENT_SCOPE_PLUS_BOUNDED_DELTA_CLOSURE
OPEN_MATERIAL_DOCUMENT_FINDINGS = 0
EXTERNAL_IMPLEMENTATION_AUTHORITY_GAP = OPEN_BY_DESIGN
OWNER_ACCEPTANCE = NOT_PERFORMED
PROPOSAL_SUBMISSION_READY = YES
PRODUCT_IMPLEMENTATION_REVIEW = NOT_PERFORMED
PRODUCT_IMPLEMENTATION = NOT_STARTED
FOUR_ARTIFACT_CANDIDATE = NOT_BUILT
CANDIDATE_DIFF = NOT_RUN
PRODUCT_SPEC_COMPLIANCE = NOT_ASSESSED
IMPLEMENTATION_ALLOWED = NO
PRODUCT_MERGE_READY = NO
PRODUCTION_OPERATION_ALLOWED = NO
NEXT_ACTION = OWNER_DECISION_ON_EXACT_PROPOSAL_OR_PROVIDE_EXISTING_ACCEPTED_AUTHORITY
```

## Reviewed file SHA-256 manifest

Hashes cover the exact bytes independently read at this review. This report excludes its own hash to avoid a self-reference; its caller may hash it after writing. Later changed document/evidence bytes require only the affected delta and invalidated dependencies to be rechecked.

| File | SHA-256 | Bytes |
|---|---|---|
| `REPORT.md` | `95373b03f9827069b4b8f656c3ba6c1effec1b36b12dfc8a955d573e090aa4aa` | 7213 |
| `DEVELOPMENT_PREFLIGHT.md` | `9ccbc58d6b2330788e7a84c33d6d7e0766f5a59b255571a8483ec3ada0b8e935` | 1355 |
| `IMPLEMENTATION_PLAN.md` | `08bf9c9a0215ff830613454397904ed636eebeb8e73851be90c811217a10374d` | 3371 |
| `evidence/authority-review.md` | `788c3557dc975a613cf6b9ce521b0071ab73c59c7b23ed1a349566871915fbc0` | 12019 |
| `evidence/canonical-audit.md` | `07976f484196f496c70f2d18fd04cf10ce0aecdbaf82fc563a793a64aef44842` | 8804 |
| `evidence/intent-outcome-audit.md` | `46023651521127f44572ff4f0950d76749e30306b3c937274c7600b5391efde6` | 11065 |
| `evidence/remote-authority-search.json` | `c382b646e54ca23b39049148c083698d8cc8df5a1e18a52ef08bfe9927017b51` | 706 |
| `evidence/source-verification.json` | `5737f5593e465c8966770e48a1183da6180ffd658f3ac29bca7f0f1d87b24ace` | 4987 |
| `evidence/upstream-pr15.json` | `3dd921e12e50b72de32bd3e70d48a37bf719e00831d41734f0149005ae47ac7a` | 3190 |
| `proposed/DSH_CODEX_SHARED_AUTH_PROTECTION_RESTORE_V1.md` | `e99ab78adb0c6fb37d51f64a9f79e921ff30c73d35861b0d292da8bbf53a13b4` | 10791 |
| `spec-sources/AGENT_CORE_FLEET_SHARED_CODEX_AUTH_V3.md` | `a02cf835d321503baa2d5b81ee23987a6ad8ce8ecf1921ce3ddbf227ce4c1421` | 81703 |
| `/tmp/025-restore-work/plugin-main/docs/specs/DSH_CODEX_SHARED_AUTH_PROTECTION_RESTORE_V1.md` | `e99ab78adb0c6fb37d51f64a9f79e921ff30c73d35861b0d292da8bbf53a13b4` | 10791 |
