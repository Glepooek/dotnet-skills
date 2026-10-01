## Summary

<!-- Describe the change and why it is needed. Keep the scope focused. -->

## Related issue

<!-- Link the issue this addresses, for example: Fixes #123. Use N/A for small fixes. -->

## Validation

<!-- List the commands you ran and their results, or explain why validation is not applicable. -->

## Checklist

- [ ] I searched existing issues and pull requests to avoid duplicates.
- [ ] I kept this pull request focused and avoided unrelated refactors.
- [ ] I added or updated tests, evals, or documentation when changing skill or agent behavior.
- [ ] I updated CODEOWNERS when adding or moving owned content.
- [ ] I updated all marketplace manifests when plugin metadata changed.
- [ ] I updated `eng/known-domains.txt` for any new external domains referenced by skill content.

<details>
<summary>Evaluation changes only</summary>

Complete this section only when the pull request changes an eval, fixture, grader, or golden
reference.

- [ ] Every stimulus is necessary, fits the target, and adds distinct capability/risk/journey value.
- [ ] Prompts are natural and non-cued; no-op and dormancy boundaries are covered where needed.
- [ ] Deterministic graders cover the complete in-scope file set; golden evidence passes and a realistic mutation fails.
- [ ] The eval has enough independent stimuli for its expected tie rate.
- [ ] The production skill or agent path passes under normal concurrency and the declared time budget.
- [ ] If this responds to a failing eval, I classified the failure before editing skill content.
- [ ] If this broadly changes routing or behavior, I checked separate GPT-family and Claude-family evidence.

</details>
