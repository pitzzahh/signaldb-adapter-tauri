# Releasing

## Main line (3.x)

Push to `main` with a version bump in `package.json` (or merge the release PR). The publish workflow runs tests, typecheck, and the size budget, then publishes to npm with the `latest` tag and creates the GitHub release.

## Maintenance lines (2.x)

Each supported line has a branch: `maintenance/2.4.x`, `maintenance/2.3.x`, `maintenance/2.2.x`, `maintenance/2.1.x`. Never merge these into `main`; they are parallel release lines, and merging one would regress `main` to old code.

To ship a patch (example: 2.3.2):

1. Branch from the line: `git checkout -b fix/2.3.x/short-topic maintenance/2.3.x`
2. Commit the fix plus the version bump and `CHANGELOG.md` entry.
3. Open a PR targeting the maintenance branch (for example `maintenance/2.3.x`). Tests run on the PR.
4. Merge the PR. The merge pushes a `package.json` change, so the publish workflow runs: tests, then `npm publish` with the line's tag (`lts-2.3`), then the GitHub release and tag. No manual steps.

The npm tag is picked by version, not by branch: anything older than registry `latest` goes to `lts-<major.minor>`. Old lines cannot move `latest`.

## Manual fallback

If a release needs a rerun without a new push, dispatch the workflow by hand: `gh workflow run publish.yml --ref maintenance/2.3.x`. It republishes nothing that is already on npm.
