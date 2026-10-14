# report-tofu-plan-action

A GitHub Action that shows a saved OpenTofu plan in the job summary and, on pull requests, in a comment that is updated on every run instead of adding a new one.

## Requirements

- OpenTofu on the `PATH`, for example from `opentofu/setup-opentofu` with `tofu_wrapper: false`.
- A plan saved with `tofu plan -out=<file>` in an initialized working directory.
- To comment on pull requests, the job needs the `pull-requests: write` permission.

## Usage

```yaml
- name: Plan infrastructure changes
  run: tofu -chdir=infra plan -input=false -out=tfplan

- name: Report the plan
  if: always()
  uses: gi-org-pl/report-tofu-plan-action@v1
  with:
    working-directory: infra
```

With `if: always()` the action also runs when the plan fails, and reports the failure in the summary and the comment.

## Inputs

| Input               | Description                                                      | Required | Default               |
|---------------------|------------------------------------------------------------------|----------|-----------------------|
| `plan-file`         | Saved plan file, relative to `working-directory`                 | No       | `tfplan`              |
| `working-directory` | Directory where OpenTofu was initialized                         | No       | `.`                   |
| `comment`           | Whether to comment the plan on pull requests                     | No       | `true`                |
| `github-token`      | Token that posts the comment, with `pull-requests: write`        | No       | `${{ github.token }}` |

## Example workflow

```yaml
name: integrate

on:
  pull_request:

jobs:
  infra:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v6

      - uses: opentofu/setup-opentofu@v2
        with:
          tofu_version_file: infra/.opentofu-version
          tofu_wrapper: false

      - name: Initialize OpenTofu
        run: tofu -chdir=infra init -input=false

      - name: Plan infrastructure changes
        run: tofu -chdir=infra plan -input=false -lock-timeout=10m -out=tfplan

      - name: Report the plan
        if: always()
        uses: gi-org-pl/report-tofu-plan-action@v1
        with:
          working-directory: infra
```

On a `push` workflow, such as a deploy that applies the saved plan, the same step writes only the job summary.

## How it works

The action runs `tofu show -no-color` on the saved plan and turns it into a collapsible `diff` block, so additions, changes and deletions are coloured. The headline is the plan summary line, such as `Plan: 1 to add, 2 to change, 0 to destroy.`

On pull requests the comment starts with a hidden marker that includes the working directory. The next run finds the comment by this marker and updates it, so every working directory has one comment. Plans longer than 60 000 characters are truncated to fit in a comment. Sensitive values stay hidden, as in `tofu show`.

The action is a composite action that runs `report-plan.js` with `actions/github-script`. Run the tests with `node --test`.

## Authors

Action author is [Oskar Barcz](https://github.com/oskarbarcz), CTO of **[Generacja Innowacja](https://gi.org.pl)** —
Poland's first technology-first NGO.

## License

MIT
