# Vally shadow evaluation adapter

`adapt.mjs` converts a Vally experiment's baseline and skilled `results.jsonl`
files into per-skill `results.json` verdicts for the shadow-evaluation
workflow. The local runner `eng/run-skill-evals.sh` runs the experiment and then
invokes this adapter; CI invokes `adapt.mjs` directly.

## Reliability signals

The adapter keeps infrastructure reliability distinct from a skill-quality
result:

- `state` is the authoritative four-state result:

  | State | Meaning |
  |-------|---------|
  | `VALID_PASS` | The completed comparison shows a statistically credible preference improvement with at least a 20% net win. |
  | `VALID_REGRESSION` | Reserved for an objective completion regression. The current Vally compare output does not provide a gate-eligible objective completion primitive, so the adapter does not emit this state yet. |
  | `VALID_NO_CHANGE` | The completed comparison does not show a credible improvement. A credible LLM preference loss is recorded as `preferenceRegressed: true`, but stays report-only. |
  | `INVALID_INCONCLUSIVE` | The run cannot support a quality verdict because evidence is missing, underpowered, errored, unmatched, or inconsistent. |

- `stateReason` gives the machine-readable cause and phase. Use it instead of
  parsing `reason`.
- Renderers treat legacy `regressed: true` records that have no `state` as
  report-only preference losses. They do not relabel historical preference data
  as objective completion regressions.
- `erroredCount` counts matched baseline/treatment trials whose comparison judge
  failed. `errors[]` classifies unresolved failures, including
  `judge_session_idle_timeout`, `judge_organization_disabled`,
  `judge_rate_limited`, and `judge_service_error`.
- The adapter retries a comparison once when judgment slots fail. It freezes all
  successful first-attempt judgments and uses the retry only to fill slots that
  errored. `comparisonAttempts`, `recoveredErrors[]`, and `errors[]` preserve the
  attempt history. Recovery requires Vally to emit `trialIndex` for both
  attempts. If that stable key is absent, the adapter fails closed with
  `retry_result_missing` instead of pairing trials by array position.
- `unmatchedBaseline` and `unmatchedTreatment` list trajectories that could not
  be paired, commonly because one arm timed out or failed before grading.
  `unmatchedTrialCount` is their combined count.
- `conclusive` is `false` when either signal is nonzero. An inconclusive verdict
  cannot pass and is rendered as a workflow warning rather than as evidence
  that a skill regressed.
- `underpowered` is a separate signal with the same "not evidence of a
  regression" property, but a different cause: the eval counted fewer than
  `minCredibleStimuli` distinct stimulus votes, so no possible win/tie/loss record could have
  reached the sign test's 5% threshold. It is a property of the eval spec, not
  of the run, and it is fixed by adding independent, discriminating stimuli —
  never by raising `defaults.runs` or changing the skill. See
  `eng/eval-quality/README.md`.
- `scenarioEvidence` collapses repeated runs for one stimulus into one effective
  stimulus vote. It is authoritative (`gateEligible: true`) for the sign test,
  net-win floor, and verdict. `comparisonTrialEvidence` keeps the pooled run
  outcomes as reliability-only evidence (`gateEligible: false`).
- `completionTransitions` reports aggregate baseline/treatment pass transitions.
  Vally's aggregate pass can include LLM grading, so this signal is also
  report-only (`gateEligible: false`). `VALID_REGRESSION` must not be inferred
  from it. See [Objective completion contract](#objective-completion-contract).

CI passes `--expected-evals` with the exact pre-run eval manifest. The adapter
writes one result file for every expected eval, including explicit invalid
results when a baseline or skilled variant is missing or comparison invocation
fails. A parsed comparison record with an invalid shape becomes
`comparison_report_invalid` for that eval instead of aborting the remaining
batch. The adapter also writes `adapter-summary.json` with expected, observed,
missing, unexpected, invalid, and written counts. The workflow requires the
number of primary result files to equal the manifest count.

The adapter consumes Vally JSONL and CLI output only. Vally 0.9 and 0.13 both
emit `stimulusName` plus a required `trialIndex` for comparison trials. The
index is stable when `compare` is repeated over the same persisted inputs, but
Vally does not promise a global ID across regenerated runs or future versions.
Vally 0.13 exits nonzero when every judge slot errors while still writing the
comparison report. The adapter reads that report, retries the identified slots,
and treats a nonzero invocation with no report as a hard failure.

## Reporting contract

`consolidate.mjs --format simple` produces the PR decision and repair view. It
preserves the execution model on every row, reports unique skill and
model/skill-result counts, aggregates `adapter-summary.json` accounting, keeps
Overfit visible, and uses distinct labels for improved, not proven improved,
report-only preference loss, and invalid evidence. It states that objective
regression is not enabled while `completionTransitions.gateEligible` is false.

The compact table keeps only gate evidence, warnings, and the next action.
`--format full` adds magnitude-weighted preference and absolute quality metrics
and includes every result detail. Compact details are limited to non-passing,
invalid, or warning-bearing results. Repeated-run W/T/L is shown only as
reliability evidence, never beside the distinct-stimulus sign test as if both
used the same inference unit.

## Practical preference floor

The sign test proves that the direction is unlikely under a 50/50 null, but
ties are outside its sample. Without an effect-size floor, 100 distinct
stimulus votes with `5W/95T/0L` have `p=0.03125` and pass although the skilled
arm improves only 5% of tested tasks. A preference pass therefore requires both:

```text
signTest.pValue <= 0.05
abs((wins - losses) / stimulusVotes) >= 0.20
```

The mirrored 20% floor applies to report-only preference regressions. The floor
uses only win/tie/loss direction; judge magnitude cannot affect it. Exhaustive
enumeration shows that every sign-test pass through 25 stimulus votes clears
20%: `5W/20T/0L` is exactly 20%, and 26 votes is the first size where
`5W/21T/0L` falls below it. The largest current eval has 17 distinct stimuli, so
the floor does not remove any currently possible pass.

Repeated runs can stabilize one task, but they do not create new task samples.
The adapter therefore gives each stimulus one majority-direction vote. For
example, five stimuli run three times produce five gate votes, not 15. The
pooled 15-run W/T/L remains visible under `comparisonTrialEvidence` so reliability
changes are not hidden.

## Policy provenance and power

Vally defines a [stimulus as a test case](https://microsoft.github.io/vally/concepts/how-it-works/)
and defines repeated runs as inputs to pass rate, pass@k, pass^k, and flakiness.
Its [scoring guidance](https://microsoft.github.io/vally/concepts/scoring/)
recommends three runs for CI and 5–10 for nightly evaluation. Those values
measure within-stimulus reliability. Vally does not prescribe a number of
distinct stimuli, a sign-test alpha, or a practical net-win floor.

This repository uses a predeclared one-sided exact sign test at `alpha=0.05`
for an improvement claim. The five-stimulus floor is derived from that policy:
`0.5^4=0.0625` cannot pass, while `0.5^5=0.03125` can. It is only an eligibility
floor. It is not 80% power. Under an idealized no-tie model, the exact number of
discordant stimulus votes needed for at least 80% power is:

| True conditional win probability | Votes needed |
|---:|---:|
| 0.60 | 158 |
| 0.65 | 69 |
| 0.70 | 37 |
| 0.75 | 23 |
| 0.80 | 18 |
| 0.90 | 8 |

These are planning values, not Vally requirements. Ties require more total
stimuli because they do not enter the sign test. A non-pass is therefore not
proof that the skill has no effect.

The table is sign-test power before the 20% practical floor. At a true 60%
conditional win rate, 158 votes give the sign test 80.6% power, but the combined
gate passes about 52.2% of records because the expected effect sits exactly on
the floor. The gate is intended to certify effects above that practical
threshold.

## Objective completion contract

`VALID_REGRESSION` stays reserved until the harness can compute this tri-state
primitive for each `(eval, stimulus, trialIndex, arm)`:

| Value | Definition |
|-------|------------|
| `true` | Every explicitly designated objective-completion grader passed. |
| `false` | At least one designated grader explicitly failed, and none was missing or errored. |
| `unknown` | No grader was designated, or any designated result was missing, errored, duplicated, or mismatched. |

Gate-eligible graders must be explicitly named in the eval, use a frozen
repository allowlist of deterministic grader types, and have task-completion
semantics. `kind: "code"` alone is not sufficient. LLM and human graders,
aggregate scores, thresholds, and Vally's aggregate `gradeResult.passed` are
prohibited. The grader `type` must come from the trusted parsed eval spec or a
generated sidecar; official Vally `GraderResult` records expose broad `kind`
taxonomy, not the spec's `type`. The harness must prove that explicit unique
grader identities round-trip to raw `gradeResult.details`, fail closed on any
missing, duplicate, suffixed, mismatched, or errored result, and pair arms by
`(stimulusName, trialIndex)`.

A baseline-pass/treatment-fail pair is an objective regression candidate, not a
hard regression by itself because agent execution is still stochastic.
`VALID_REGRESSION` requires conclusive predeclared paired confirmations, an
exact one-sided test at `p <= 0.05`, an objective net-loss rate of at least 20%,
and multiple-scenario correction when more than one completion scenario is
tested. Until evals can declare these graders and the harness proves a stable
spec-to-result identity mapping, `completionTransitions.gateEligible` remains
`false`.

## Correctness metrics

Track these metrics by model, judge, plugin, skill, and run:

| Metric | Source | Use |
|--------|--------|-----|
| Manifest completeness | `expectedEvalCount`, `writtenResultCount`, `unexpectedEvalCount` | Detect silent result loss or extra results |
| Invalid-result rate and cause | `state`, `stateReason`, `errors[].code` | Keep infrastructure and eval-design failures out of skill verdicts |
| Judge retry recovery | `comparisonAttempts`, `recoveredErrors[]`, `errors[]` | Measure transient judge failure and persistent failure separately |
| Independent task evidence | `scenarioEvidence`, `stimulusVoteCount`, stimulus W/T/L | Gate on one vote per distinct stimulus |
| Repeated-run reliability | `comparisonTrialEvidence`, `scenarios[].trials` | Show run volume, consistency, and flakiness without manufacturing task breadth |
| Preference effect and uncertainty | `netWin`, `signTest`, `practicalSignificance` | Require statistical and practical skilled-versus-baseline improvement |
| Completion transitions | `completionTransitions` | Diagnose possible completion changes without treating aggregate LLM grading as objective |
| Cross-judge agreement | Explicit `state` plus `preferenceRegressed` | Measure judge robustness without conflating preference loss with objective regression |

Inspect the raw variant `results.jsonl` before changing a skill. A
`status: "error"` agent timeout is different from a successful pair whose
comparison evidence says `Comparison judge failed`. Do not add fixture setup,
SDK pinning, or skill instructions unless the failure occurred during that
phase.
