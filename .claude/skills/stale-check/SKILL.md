---
name: stale-check
description: Check for stale branches, open PRs, and drift from the base branch before starting or reviewing a slice. Run this before any new task.
---

# Stale branch & PR check

Run this **before starting a slice** and **before reviewing one**. On a long multi-phase build the most
expensive failure is two slices editing the same files from different bases, and that is invisible unless
somebody looks.

```bash
# 1. What is already in flight? An open PR touching your files means coordinate, not proceed.
gh pr list --state open --json number,title,headRefName,updatedAt,files \
  --jq '.[] | "#\(.number) \(.headRefName) — \(.title) (updated \(.updatedAt))"'

# 2. Is this branch behind its base? A slice built on a stale base merges dirty.
git fetch origin --quiet
git rev-list --count HEAD..origin/master        # commits on master we do not have
git rev-list --count HEAD..origin/feat/PLAT-1-multi-surface-platform 2>/dev/null || true

# 3. Which remote branches are merged and can be deleted?
git branch -r --merged origin/master | grep -v 'origin/master\|origin/HEAD' || echo "none"

# 4. Which remote branches have gone quiet? Anything older than ~2 weeks with no PR is a candidate.
git for-each-ref --sort=-committerdate refs/remotes/origin \
  --format='%(refname:short)  %(committerdate:relative)'
```

## How to act on it

| finding | action |
|---|---|
| An open PR touches files in your slice | **Stop and report it.** Do not edit those files in parallel; the supervisor decides whether to rebase, wait, or re-scope. |
| Your branch is behind its base | Rebase onto the base before starting. Starting from a stale base is how a clean review turns into a merge conflict nobody reads. |
| A merged branch still exists on the remote | Report it for deletion. Do not delete branches yourself — the supervisor owns the git history. |
| A branch is quiet, unmerged, and has no open PR | Report it. It is either abandoned work to drop or unfinished work to finish, and both need a human-level decision. |

## Known state at the start of this build

`feat/BOT-11-phase-1-defect-fixes`, `feat/OPS-7-continuous-deployment` and `feat/OPS-7-bump-action-versions`
were all merged to `master` and their remote branches can be deleted. `feat/PLAT-1-multi-surface-platform`
is the long-lived integration branch — it is *supposed* to be long-lived, so age is not staleness there.
