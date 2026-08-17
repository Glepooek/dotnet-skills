import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const script = join(dirname(fileURLToPath(import.meta.url)), "consolidate.mjs");

function render(verdicts) {
  const root = mkdtempSync(join(tmpdir(), "vally-consolidate-"));
  try {
    const input = join(root, "results.json");
    const output = join(root, "summary.md");
    writeFileSync(input, JSON.stringify({ verdicts }));
    const result = spawnSync(
      process.execPath,
      [script, "--format", "simple", "--output", output, input],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    return readFileSync(output, "utf8");
  } finally {
    for (const file of ["results.json", "summary.md"]) {
      try {
        unlinkSync(join(root, file));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    rmdirSync(root);
  }
}

test("renders new states and reliability evidence without calling preference loss an objective regression", () => {
  const markdown = render([
    {
      skillName: "preference-loss",
      state: "VALID_NO_CHANGE",
      stateReason: { code: "preference_regression_report_only" },
      preferenceRegressed: true,
      regressed: true,
      passed: false,
      conclusive: true,
      reason: "credible preference loss",
      recoveredErrors: [{ code: "judge_session_idle_timeout" }],
      scenarioEvidence: { count: 1, wins: 0, ties: 0, losses: 1 },
      scenarios: [],
    },
    {
      skillName: "judge-failure",
      state: "INVALID_INCONCLUSIVE",
      stateReason: { code: "comparison_errors" },
      passed: false,
      conclusive: false,
      underpowered: false,
      reason: "comparison failed",
      errors: [
        { code: "judge_organization_disabled" },
        { code: "judge_organization_disabled" },
      ],
      scenarios: [],
    },
  ]);

  assert.match(markdown, /\*\*0 objective regressions\*\*/);
  assert.match(markdown, /\*\*1 preference losses \(report only\)\*\*/);
  assert.match(markdown, /`VALID_NO_CHANGE` \(`preference_regression_report_only`\)/);
  assert.match(markdown, /`judge_organization_disabled`=2/);
  assert.match(markdown, /successful first-attempt judgments stayed fixed/);
  assert.match(markdown, /Effective scenarios \(report only\):\*\* 1 \(0W\/0T\/1L\)/);
});

test("renders legacy preference regressions as report-only", () => {
  const markdown = render([
    {
      skillName: "legacy-regression",
      regressed: true,
      passed: false,
      conclusive: true,
      reason: "legacy credible loss",
      scenarios: [],
    },
  ]);

  assert.match(markdown, /\*\*0 objective regressions\*\*/);
  assert.match(markdown, /\*\*1 preference losses \(report only\)\*\*/);
  assert.match(markdown, /`VALID_NO_CHANGE`/);
});

test("keeps passing detail blocks when the comment budget permits", () => {
  const markdown = render([
    {
      skillName: "passing-skill",
      state: "VALID_PASS",
      passed: true,
      conclusive: true,
      reason: "credible preference improvement",
      scenarios: [],
    },
  ]);

  assert.match(markdown, /passing-skill — details/);
  assert.match(markdown, /`VALID_PASS`/);
});
