# Investigating Evaluation Results (Vally)

This guide is for AI agents (and humans) investigating skill evaluation failures produced by the **Vally** harness via `eng/vally-adapter/adapt.mjs`. It documents the `results.json` schema, how to reach the raw Vally output, common failure patterns, and recommended fixes.

Evaluations run through Vally (`@microsoft/vally-cli`): every skill's `tests/<plugin>/<skill>/eval.yaml` is run in up to three variants — **baseline** (no skills), **skilled** (only the skill under test), and **plugin** (the whole plugin loaded). The workflow records the exact expected-eval manifest before execution. The adapter then runs `vally compare` (a debiased, position-swapped head-to-head judgment of skilled vs baseline) and writes one `results.json` per expected skill, including an explicit invalid result when required evidence is missing.

> Note: the linter (`skill-validator check`) is a **separate** workflow (`skill-check.yml`) and is unrelated to these eval results.

## Using this guide with an AI agent

When an evaluation has failures, the PR comment includes a ready-to-use prompt — copy it to your AI agent. The agent downloads the artifacts, reads this guide, analyzes the `results.json` files, and suggests fixes.

## Quick start

1. **Download the results artifacts:** `gh run download <run-id> --repo dotnet/skills --pattern "vally-results-*" --dir ./eval-results`
2. **Skim the run's step summary** (the "Full Results" link) for the consolidated pass/fail table.
3. **Read `adapter-summary.json` and each `results.json`** (`eval-results/vally-results-*/<plugin>/<skill>/results.json`). The summary proves expected-versus-produced accounting; each skill file gives the compare state and evidence.
4. **Identify the failure pattern** using the categories below and fix in priority order: infra/errored trials → timeouts → activation → quality/preference.
5. **Apply the fix** and re-run with `/evaluate`.

> The `--pattern "vally-results-*"` flag matters — without it, `gh` also tries to download non-zip artifacts and exits non-zero.

## The PR comment

`eng/vally-adapter/consolidate.mjs` renders the comment (and the fuller step summary). Its table has these columns:

| Column | Meaning |
|--------|---------|
| `Skill` | Skill under test |
| `Result` | ✅ `VALID_PASS` / 🔻 objective `VALID_REGRESSION` / ❌ `VALID_NO_CHANGE` / 📉 report-only LLM preference loss / ⚠️ `INVALID_INCONCLUSIVE` |
| `Net win` | `(wins − losses) / trials`. Must be at least +20% for a pass |
| `p` | One-sided exact sign test over the discordant (non-tie) trials. A skill passes only at `p ≤ 0.05`, which needs at least 5 winning trials |
| `Δ Pref` | The same comparison weighted by how decisive each win was (`much-better` ±100%, `slightly-better` ±40%). Triage only; deliberately not gated on |
| `W/T/L` | Wins / ties / losses across trials |
| `Quality` (+ `Quality (Plugin)` in the full step summary) / `Baseline` | Mean absolute judge score 0–5 for skilled isolated (and plugin) vs the skill-free control |
| `Overfit` | Overfitting-judge severity — ✅ Low, 🟡 Moderate, 🔴 High, — none — with its score |
| `Skills Loaded` | Of scenarios that expect activation, how many the skill activated / that total (plugin run shown when present); ⚠️ flags a scenario that expected activation but didn't activate |

A collapsible **Column legend** and a per-skill **details** block follow the table. Each details block shows `state`, `stateReason`, comparison-error codes, retry recovery, report-only effective-scenario evidence, the human-readable `reason`, and a per-scenario table. `--format full` (the step summary) adds the `Quality (Plugin)` column; `--format simple` (the PR comment) omits it.

## Understanding `results.json`

Each file has a top-level object:

| Field | Description |
|-------|-------------|
| `schemaVersion` | Adapter schema version. Version 2 adds explicit states and evidence provenance |
| `evalFile` / `expectedEval` | Normalized eval path and whether it was in the pre-run manifest |
| `model` | Model used for agent runs |
| `judgeModel` | Model used by `vally compare` |
| `timestamp` | When results were written (UTC) |
| `verdicts[]` | Per-skill results (one entry, since the adapter writes one file per skill) |

### Verdict structure

A verdict carries **both** the head-to-head preference and absolute per-role data. `state` is authoritative. Boolean fields remain for compatibility with older consumers.

| Field | Description |
|-------|-------------|
| `skillName` / `skillPath` | The skill under test |
| `state` | One of `VALID_PASS`, `VALID_REGRESSION`, `VALID_NO_CHANGE`, or `INVALID_INCONCLUSIVE` |
| `stateReason` | Machine-readable `{ code, phase }`. Use this field for automation; do not parse `reason` |
| `passed` | **The gate.** `true` only when `conclusive`, not `underpowered`, `signTest.pValue <= 0.05`, and `netWin >= 0.20` |
| `netWin` | `(wins − losses) / trials` — the effect size the gate reads. Magnitude-free, so an identical W/T/L record always yields an identical verdict |
| `practicalSignificance` | `{ netWin, minimum, passed }`. The absolute directional effect must reach 20%; this blocks sparse records such as `5W/95T/0L` |
| `signTest` | `{ wins, ties, losses, discordant, pValue, alpha }` — exact one-sided binomial tail over the discordant (non-tie) trials. **This is what decides.** Ties can't support a win, so they hold `discordant` down |
| `regressed` / `preferenceRegressed` | Compatibility and explicit fields for a credible LLM preference loss. Under schema version 2 this maps to `VALID_NO_CHANGE`, not `VALID_REGRESSION`, because ordinal LLM preference is not objective completion evidence. Renderers apply the same report-only meaning to legacy records that have `regressed: true` but no `state` |
| `conclusive` | `false` when the comparison didn't complete: errored trials, unmatched trajectories, or a summary that disagrees with its own `stimuli[].trials` |
| `underpowered` | `true` when a *completed* comparison counted fewer than `minCredibleTrials` trials, so no record could have reached `p <= 0.05`. Rendered ⚠️ — never a pass, never a regression. Disjoint from `conclusive` |
| `minCredibleTrials` | The trial floor in force (5). See `eng/eval-quality/README.md` for why |
| `meanScore` | Vally's magnitude-weighted mean preference (`much-better` ±1.0, `slightly-better` ±0.4), −1..1. **Triage only — not the gate**; weighting the statistic by magnitude is what made verdicts flip in dotnet/skills#952 |
| `confidenceInterval` | `{ low, high, level: 0.95 }` — the 95% CI on `meanScore`, reported alongside it |
| `winRate`, `wins`, `ties`, `losses` | Trial-level head-to-head tally as vally reported it |
| `trialCount`, `erroredCount` | Counted trials (scenarios × `defaults.runs`) and how many errored (errored trials don't count toward either statistic) |
| `comparisonAttempts` | Retry telemetry. Successful first-attempt slots are frozen; only errored slots can be filled by attempt 2 |
| `errors[]` / `recoveredErrors[]` | Structured unresolved and recovered comparison failures, with phase, code, stimulus, trial, and attempt provenance |
| `scenarioEvidence` | One effective vote per stimulus after repeated runs are collapsed. Report-only (`gateEligible: false`) |
| `completionTransitions` | Baseline/treatment aggregate pass transitions. Report-only because Vally aggregate pass can include LLM grading |
| `reason` | Human-readable summary of the above |
| `scenarios[]` | Per-scenario detail (below) |

### Scenario structure

Each scenario merges the compare preference for that stimulus with the absolute per-role runs.

| Field | Description |
|-------|-------------|
| `scenarioName` | The stimulus name from the eval spec |
| `meanScore` / `trials[]` | Compare preference for this stimulus and its per-trial `{ winner, magnitude, score, evidence, errored }` |
| `expectActivation` | Whether the skill is expected to activate (always `true` today) |
| `timedOut` | Whether the skilled run hit its timeout |
| `skillActivationIsolated.activated` | Did the skill activate in the skilled (isolated) run? |
| `skillActivationPlugin.activated` | Did it activate in the plugin run? (present only when a plugin variant ran) |
| `baseline` | `{ judgeResult: { overallScore }, metrics }` — the skill-free control (`overallScore` is 0–5) |
| `skilledIsolated` | Same shape, for the isolated skilled run |
| `skilledPlugin` | Same shape, for the whole-plugin run (may be absent) |

`metrics` on each role: `{ wallTimeMs, tokenEstimate, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }`.

### Adapter summary

`adapter-summary.json` is the result-set accounting record. It contains
`expectedEvalCount`, `observedEvalCount`, `writtenResultCount`, `missingEvals`,
`unexpectedEvals`, and `invalidEvals`. The workflow also checks that the number
of primary result files equals the exact pre-run manifest count. A missing eval
cannot disappear while unrelated results make the job look complete.

## Reaching the raw Vally output

The adapter's `results.json` is a summary. The uploaded artifact also contains the full Vally run under `artifacts/TestResults/vally/<entry>/`:

- `_experiment/<timestamp>/<variant>/results.jsonl` — one `trial-result` record per stimulus per variant, each with the full `trajectory` (`endReason`, `metrics.tokenUsage`, `metrics.skillActivationCount`, `toolCallCount`) and `gradeResult.score` (0–1).
- `_experiment/<timestamp>/executor-session-logs/**/{metadata.json,events.jsonl}` — the per-session event stream (prompts, tool calls, agent output). `metadata.json` carries `variant`, `stimulusName`, `evalName`/`evalFilePath`, `model`, and `status`. This is what powers the AGENTVIZ replay link in the PR comment.

To see exactly what the agent did for a failing scenario, open its `events.jsonl` (match on `variant` + `stimulusName` in the sibling `metadata.json`).

## Failure patterns and fixes

Work top-down; earlier categories often cause later ones.

### 1. Errored or missing trials (`state == "INVALID_INCONCLUSIVE"`)
The agent crashed, the model was unavailable, evidence was missing, or the comparison judge failed. Check `stateReason`, `errors[]`, `adapter-summary.json`, and the variant's `results.jsonl`/session logs. These are invalid measurements, not skill regressions. If a required variant produced no records, the adapter writes an explicit invalid result with `missing_baseline_records` or `missing_skilled_records`.

If Vally writes a JSON record that cannot satisfy the comparison schema, the
adapter emits `comparison_report_invalid` for that eval and continues the batch.
This preserves exact result accounting without treating malformed evidence as a
quality result.

For comparison-judge failures, inspect `errors[].code`. Known codes include
`judge_session_idle_timeout`, `judge_organization_disabled`,
`judge_rate_limited`, and `judge_service_error`. The adapter makes one targeted retry. It keeps every
successful first-attempt judgment fixed and replaces only errored slots. A
recovered transient appears in `recoveredErrors[]`; an unresolved failure stays
in `errors[]` and makes the state invalid.

### 2. Timeouts (`scenario.timedOut == true`, `trajectory.endReason == "agent_timeout"`)
The agent didn't finish within the eval's `config.timeout`. Either the task is too large for the budget or the skill sent the agent down a slow path. Fixes: raise `config.timeout` in `eval.yaml` if the task legitimately needs more time, or tighten the skill so it converges faster.

### 3. Skill didn't activate (`skillActivationIsolated.activated == false`)
The skill was available but the agent never invoked it, so "skilled" ≈ "baseline" and no improvement is possible. Fixes: sharpen the skill's `description`/trigger phrasing in `SKILL.md` so the model recognizes when to use it, and make sure the eval prompt actually describes a task the skill targets.

### 4. Underpowered eval (`underpowered == true`)
Not a skill problem — an eval problem. This is `INVALID_INCONCLUSIVE` with `stateReason.code == "underpowered"`. The gate is an exact one-sided sign test over the head-to-head trials, and `trials = scenarios × defaults.runs`. That test cannot reach `p ≤ 0.05` on fewer than five discordant trials (`0.5⁴ = 0.0625`), and discordant trials can never exceed counted trials — so below `minCredibleTrials` (5) **no possible record passes**, however good the skill is.

Do not "fix" the skill in response to this. Fix the eval: add scenarios (strongly preferred — five repeats of one scenario satisfy the arithmetic but still measure the skill on a single task), or declare `defaults: { runs: N }` in its `eval.yaml` so `scenarios × runs >= 5`. If the spec still opens with the deprecated `config:` block, **merge** `runs` into it and rename it `defaults:` — vally's loader throws on a spec declaring both, and that failure surfaces as "Evaluation ran but produced no results", not as a spec error. `eng/eval-quality/check_eval_quality.py` fails any new eval below the floor, rejects the `config:`+`defaults:` combination, and tracks the grandfathered ones in `eng/eval-quality/underpowered-allowlist.txt`.

Clearing the floor is necessary, not sufficient. The sign test conditions on the **discordant** (non-tie) trials, so an eval at exactly 5 counted trials only passes on a flawless 5W/0T/0L sweep — one tie leaves 4 discordant and puts it back below the floor without setting `underpowered`. Check `signTest.discordant`, not `trialCount`, when a record with more wins than losses still fails.

### 5. No credible or practical net win
The judge didn't consistently prefer the skilled run over baseline.
- **`netWin <= 0`** — at least as many losses as wins. Either the skill isn't helping for these scenarios, or the baseline model is already strong here. If `preferenceRegressed` is `true`, the LLM judge credibly preferred baseline. This is report-only preference evidence, not an objective completion regression.
- **`netWin > 0` but `signTest.pValue > 0.05`** — a real but inconsistent signal: the skill wins some scenarios and ties or loses others. Ties count against here, because they hold the discordant trial count down. Add more/broader scenarios so there is enough evidence, and make the skill help consistently rather than occasionally.
- **`signTest.pValue <= 0.05` but `practicalSignificance.passed == false`** — the direction is statistically credible but too sparse to matter across counted trials. For example, `5W/95T/0L` has `p=0.03125` but only a 5% net win. Add discriminating scenarios or improve the skill; do not add repeated ties.
- Do **not** read `meanScore` here. It is magnitude-weighted and reported for triage only; a verdict never turns on it (see `eng/eval-quality/README.md`, "Why the gate scores direction, not magnitude").
- Inspect `scenarios[].trials[].evidence` for the judge's reasoning on losses/ties, and compare the skilled vs baseline `events.jsonl` to see what the skill changed (or failed to change).

### 6. Completion-transition telemetry

`completionTransitions` counts aggregate `baselinePassed` and
`treatmentPassed` transitions from Vally compare. It is not a hard gate:
Vally's aggregate pass can include LLM grader output, so it is not an objective
task-completion primitive. Do not infer an objective regression from
`completionTransitions.baselineOnly`.

The required objective primitive is tri-state per
`(eval, stimulus, trialIndex, arm)`: `true` only when all explicitly marked,
allowlisted deterministic completion graders pass; `false` when one explicitly
fails and none is missing or errored; otherwise `unknown`. It must use raw
per-grader details matched by `(graderType, name)`, never aggregate pass,
weights, thresholds, LLM graders, or human graders. One baseline-only
transition is only a candidate. `VALID_REGRESSION` additionally requires
conclusive paired confirmation at `p <= 0.05`, at least a 20% objective net
loss, and correction across multiple tested completion scenarios.

Vally 0.13 supplies `graderType` in raw grader details, but evals do not yet
declare which deterministic graders are task-completion invariants and compare
JSONL still exposes only aggregate booleans. Therefore the state remains
reserved and the aggregate transition remains report-only.

### Vally 0.13 comparison identity

Vally 0.13 comparison trials retain the `(stimulusName, trialIndex)` identity
used by retry merging. Repeated compare calls over the same persisted inputs
produce the same indices. Do not treat the index as a durable ID across
regenerated runs or future Vally versions. An all-errored comparison exits
nonzero in 0.13 after writing its report; the adapter reads that report so it
can retry and classify the failure.

### 7. Quality looks fine but the skill still fails the gate
The gate is a **preference** comparison, not an absolute score. A high `skilledIsolated.judgeResult.overallScore` that isn't clearly better than `baseline.judgeResult.overallScore` will not pass. Focus on the *delta* over baseline, not the absolute number.

## Re-running

Push the fix and comment `/evaluate` on the PR (optionally `/evaluate <plugin>` to scope). The workflow re-runs Vally, regenerates the verdicts, and updates the PR comment.
