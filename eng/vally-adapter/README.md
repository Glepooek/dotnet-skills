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
  | `VALID_PASS` | The completed comparison shows a credible preference improvement. |
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
  `minCredibleTrials` trials, so no possible win/tie/loss record could have
  reached the sign test's 5% threshold. It is a property of the eval spec, not
  of the run, and it is fixed by adding scenarios or raising `defaults.runs` —
  never by changing the skill. See `eng/eval-quality/README.md`.
- `scenarioEvidence` collapses repeated runs for one stimulus into one effective
  scenario vote. This is report-only (`gateEligible: false`) until the repository
  selects a practical threshold and has enough independent scenarios.
- `completionTransitions` reports aggregate baseline/treatment pass transitions.
  Vally's aggregate pass can include LLM grading, so this signal is also
  report-only (`gateEligible: false`). `VALID_REGRESSION` must not be inferred
  from it.

CI passes `--expected-evals` with the exact pre-run eval manifest. The adapter
writes one result file for every expected eval, including explicit invalid
results when a baseline or skilled variant is missing or comparison invocation
fails. It also writes `adapter-summary.json` with expected, observed, missing,
unexpected, invalid, and written counts. The workflow requires the number of
primary result files to equal the manifest count.

The adapter consumes Vally JSONL and CLI output only. It does not depend on
Vally package internals, so the result-accounting contract remains compatible
with the separate Vally 0.13 dependency update.

## Correctness metrics

Track these metrics by model, judge, plugin, skill, and run:

| Metric | Source | Use |
|--------|--------|-----|
| Manifest completeness | `expectedEvalCount`, `writtenResultCount`, `unexpectedEvalCount` | Detect silent result loss or extra results |
| Invalid-result rate and cause | `state`, `stateReason`, `errors[].code` | Keep infrastructure and eval-design failures out of skill verdicts |
| Judge retry recovery | `comparisonAttempts`, `recoveredErrors[]`, `errors[]` | Measure transient judge failure and persistent failure separately |
| Effective independent scenarios | `scenarioEvidence.count` and W/T/L | Show when repeated runs give trial volume without task breadth |
| Preference effect and uncertainty | `netWin`, `signTest`, trial W/T/L | Measure credible skilled-versus-baseline preference |
| Completion transitions | `completionTransitions` | Diagnose possible completion changes without treating aggregate LLM grading as objective |
| Cross-judge agreement | Explicit `state` plus `preferenceRegressed` | Measure judge robustness without conflating preference loss with objective regression |

Inspect the raw variant `results.jsonl` before changing a skill. A
`status: "error"` agent timeout is different from a successful pair whose
comparison evidence says `Comparison judge failed`. Do not add fixture setup,
SDK pinning, or skill instructions unless the failure occurred during that
phase.
