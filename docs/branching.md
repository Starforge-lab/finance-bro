# Branching and releases

Keep two long-lived branches. `dev` is the integration line and GitHub default branch; `main` is the stable release line.

- `dev` receives everyday work and holds the next release.
- `main` contains the latest promoted release.

## Everyday changes

Start short-lived `feat/<name>`, `fix/<name>`, `parser/<institution>-<change>`, or `chore/<name>` branches from `dev`. Open a pull request into `dev` and squash-merge it. Delete the short-lived branch after merging.

## Releasing

Open a pull request from `dev` into `main` and merge it with a merge commit. Do not squash permanent-branch promotions; the merge commit records which integration state was released. After each promotion, open a pull request from `main` back into `dev` and merge it with a merge commit. This keeps the permanent branches' ancestry in sync for the next release's up-to-date check.

For an urgent fix, branch `hotfix/<name>` from `main`, open a pull request into `main`, and merge it with a merge commit. Then sync `main` back into `dev` with a merge-commit pull request so the fix is included in the next release.

## GitHub protection

The active repository rulesets require pull requests for `main` and `dev`, resolved review comments, and the `Validate and bundle` check on an up-to-date branch. Suvo and Rohan may merge their own PRs on either branch without peer or code-owner approval, as confirmed on 12 October 2026. Reviews remain useful and may be requested, but approval after the latest push and extra approval for unattributed changes are not required. These rules do not waive a PR's acceptance criteria or the scoped release/device gates.

The rulesets block force pushes and branch deletion, and have no bypass actors. The `main` ruleset permits merge commits only. The `dev` ruleset permits both merge commits and squash merges so release and sync PRs can preserve ancestry while everyday changes stay compact.

The source-branch names and feature-to-`dev` routing above are team conventions; the target-branch rulesets do not enforce them. GitHub applies the merge-method restrictions by target branch.

## Security analysis

The advanced CodeQL workflow scans JavaScript and TypeScript on pushes and pull requests to `dev` and `main`, with an additional weekly scan. Its latest reviewed analysis succeeded on 2026-10-06. GitHub's default CodeQL setup is not configured; the workflow in `.github/workflows/codeql.yml` is the active setup. Review results in **Security → Code scanning**. `Validate and bundle` is the required branch check; CodeQL reports findings separately.

## Apply the repository settings

The public organization repository is `Starforge-lab/finance-bro`; `suvodeep12` and `RohanGupta15` both have repository admin access. `dev` is the default branch, and the active `main` and `dev` rulesets match the JSON files below. Reapply these settings as an administrator after changing either ruleset file or `.github/repository-settings.json`. From the repository root, run this PowerShell block. It updates rulesets by name when they already exist, creates missing ones, and enables automatic branch deletion only after both protections are in place:

```powershell
$rulesets = @(gh api repos/Starforge-lab/finance-bro/rulesets | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0) { throw 'Could not list repository rulesets.' }

$desiredRulesets = @(
  @{ Name = 'Protect main'; File = '.github/rulesets/main.json' },
  @{ Name = 'Protect dev'; File = '.github/rulesets/dev.json' }
)

foreach ($desired in $desiredRulesets) {
  $existing = @($rulesets | Where-Object { $_.name -eq $desired.Name })
  if ($existing.Count -gt 1) { throw "Resolve duplicate rulesets named $($desired.Name) first." }

  if ($existing.Count -eq 1) {
    gh api --method PUT "repos/Starforge-lab/finance-bro/rulesets/$($existing[0].id)" --input $desired.File
  } else {
    gh api --method POST repos/Starforge-lab/finance-bro/rulesets --input $desired.File
  }
  if ($LASTEXITCODE -ne 0) { throw "Could not apply ruleset $($desired.Name)." }
}

gh api --method PATCH repos/Starforge-lab/finance-bro --input .github/repository-settings.json
if ($LASTEXITCODE -ne 0) { throw 'Could not update repository merge settings.' }
gh api repos/Starforge-lab/finance-bro/rulesets --jq '.[] | {id, name, enforcement, bypass_actors}'
```

GitHub requires repository administration write access to manage rulesets. If the repository settings update rejects `delete_branch_on_merge`, enable that option in Settings → General after confirming both protections are active. See [GitHub's repository ruleset API](https://docs.github.com/en/rest/repos/rules) and [repository settings API](https://docs.github.com/en/rest/repos/repos#update-a-repository).


## GitHub Free and security settings

This repository is public, so repository-level branch rulesets and CodeQL are available with GitHub Free. Keep workflows on standard hosted runners; this setup requires no paid GitHub feature. See [ruleset availability](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets).

As of 2026-10-06, Dependabot alerts and security updates, secret scanning and push protection, and private vulnerability reporting are enabled in Settings → Security. The advanced CodeQL workflow is active; the default setup is not configured. Track repository setup in [issue #2](https://github.com/Starforge-lab/finance-bro/issues/2).
