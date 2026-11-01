# Commit messages

This repo uses Conventional Commits; commit messages drive the changelog and the version bump.

```text
<type>(<scope>): <summary>
```

| Type     | Use for                         |
| -------- | ------------------------------- |
| feat     | new behaviour                   |
| fix      | bug fix                         |
| perf     | performance work                |
| refactor | behaviour-neutral restructuring |
| docs     | documentation                   |
| test     | tests only                      |
| ci       | workflows/CI tooling            |
| build    | build/deps                      |
| chore    | everything else                 |
| style    | formatting only                 |

Rules:

- The summary is lowercase and imperative ("add live tab", not "Added"/"Adds").
- The scope is optional and free-form (e.g. cli, web, core, automation, runner, docs, ci).
- Breaking changes use `!` after type/scope (`feat(cli)!: ...`) or a `BREAKING CHANGE:` footer.

Enforcement: the `commit-msg` husky hook runs commitlint (`commitlint.config.mjs`), and PR titles are validated by `.github/workflows/pr-title.yml` because squash merges make the PR title the commit.

Do not bump the version by hand — Release Please does it.
