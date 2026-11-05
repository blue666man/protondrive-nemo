# The `encephalon` branch

This is a deployment branch, not a pull request. It combines the open PR
branches into one tree that a Nix configuration can build and pin.

**Base and merges**, in order, on top of `test/harness` (the shared unit-test
harness, 859f9b6):

1. `feat/allow-root` (fast-forward)
2. `fix/cache-perms`
3. `feat/niozow-backports`
4. `fix/claimed-mtime`

**Commits on top**, in order, by subject (hashes change on every rebuild).
Every one has `(encephalon)` in its subject, so `git log --first-parent
--grep='(encephalon)' --reverse test/harness..encephalon` lists them:

1. `feat(encephalon): cache policy applies to pending uploads`
2. `fix(encephalon): tmp/ copies after a revision lands; clear tmp/ in every mode`
3. `feat(encephalon): GPG credentials store from NioZow; keytar removed`
4. `feat(encephalon): Nix flake, package and home-manager module (from NioZow), fuse-native utimens patch`
5. `docs(encephalon): deployment-branch notes; cache-clear script comment`
6. `fix(encephalon): gpg encrypts only to a local key, never one fetched via WKD`
7. `fix(encephalon): the encrypted session is written atomically, mode 0600`
8. `fix(encephalon): a missing gpg is reported as such`
9. `test(encephalon): gpg test teardown always restores env and removes temp dirs`
10. `fix(encephalon): PROTONDRIVE_NEMO_CREDENTIALS_FILE moves the default account's session only`
11. `fix(encephalon): profile names tmp, blobs and pending are reserved`
12. `build(encephalon): utimens guard also fails if l->atime, 5 is left`
13. `docs(encephalon): build with npm ci --ignore-scripts and the patched native rebuild`
14. `docs(encephalon): the mount is started by hand; the systemd units are unsupported here`
15. `docs(encephalon): on-top commits listed by subject; dated rebuild tags`

**Rebuilding after a PR branch moves:**

1. `git switch -C encephalon test/harness`
2. Merge the four branches above in order. With `rerere.enabled`, the recorded
   conflict resolutions replay.
3. Cherry-pick the commits on top, in the order above (find each on the old
   branch with `git log --first-parent --grep='<subject>'`).
4. Re-run tier 1 (`npm test`), tier 2 (`npm run test:mount`) and
   `nix build .#protondrive-nemo`.
5. Re-audit the result.
6. Tag the published rebuild `encephalon-YYYY-MM-DD` (the date it is
   published). The branch is force-pushed on every rebuild; the tag keeps
   the commit a consumer pinned reachable afterwards.

Consumers pin the tagged commit (its hash, or the tag), never the branch.

**Notes:**

- `test/harness` is a local branch of the maintainer's clone; its commit is
  reachable through every PR branch.
- `docs/design/claimed-mtime.md` describes the PR branches. Here the session
  store is GPG, not keytar, so that doc's keytar remark does not apply.
