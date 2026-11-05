# The `encephalon` branch

This is a deployment branch, not a pull request. It combines the open PR
branches into one tree that a Nix configuration can build and pin.

**Base and merges**, in order, on top of `test/harness` (the shared unit-test
harness, 859f9b6):

1. `feat/allow-root` (fast-forward)
2. `fix/cache-perms`
3. `feat/niozow-backports`
4. `fix/claimed-mtime`

**Commits on top:**

- `b0655f2` cache policy applies to pending uploads
- `2921299` review fixes: tmp/ copies after a revision lands; clear tmp/ in every mode
- `5f4e07d` GPG credentials store from NioZow; keytar removed
- `0984ac2` Nix flake, package and home-manager module from NioZow; fuse-native utimens patch

**Rebuilding after a PR branch moves:**

1. `git switch -C encephalon test/harness`
2. Merge the four branches above in order. With `rerere.enabled`, the recorded
   conflict resolutions replay.
3. Cherry-pick the commits on top.
4. Re-run tier 1 (`npm test`), tier 2 (`npm run test:mount`) and
   `nix build .#protondrive-nemo`.
5. Re-audit the result.

Rebuilding rewrites history, so consumers should pin a commit, not the branch.

**Notes:**

- `test/harness` is a local branch of the maintainer's clone; its commit is
  reachable through every PR branch.
- `docs/design/claimed-mtime.md` describes the PR branches. Here the session
  store is GPG, not keytar, so that doc's keytar remark does not apply.
