# Working agreements

- Use one branch per issue, named `codex/issue-<number>-<topic>`. Commit and push the issue's changes, then open a pull request.
- Keep GitHub's automatic deletion of head branches after merge enabled.
- Run validation locally. Do not add GitHub Actions validation jobs.
- Run only focused tests for the behavior changed in the current task. The owner runs the complete suite manually.
- Publish release images only. Do not publish development, branch, pull-request or commit-only images to GitHub Container Registry.
- GitHub Actions may be used for explicitly triggered release-image publication after local validation.
- Keep changes scoped to the issue being implemented. Keep generated credentials, database data and build artifacts out of Git.
