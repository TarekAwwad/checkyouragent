# Release Checklist

Use this checklist before creating or publishing a GitHub release. The release
workflow publishes to PyPI when the GitHub release is published, so every item
below must be complete first.

## Release PR

- [ ] Merge the feature and fix PRs included in the release, then create
  `release/X.Y.Z` from the updated `main` branch.
- [ ] Open a dedicated release PR to finalize the version metadata, changelog,
  and upgrade notes. If the intended version is already set, retain it.
- [ ] Review the release scope and validation results in that PR, then merge it
  after its required CI checks pass.
- [ ] Record the resulting commit on `main` as the release commit and confirm
  CI passes for that commit before tagging it.

Merging the release PR does not publish a package. Publishing the GitHub release
is the separate action that starts the PyPI workflow.

## Scope and Metadata

- [ ] The release commit is on `main` and the working tree is clean.
- [ ] `backend/pyproject.toml`, the `checkyouragent` entry in `backend/uv.lock`,
  `frontend/package.json`, and both root version fields in
  `frontend/package-lock.json` contain the same version.
- [ ] `CHANGELOG.md` has a dated section for that version and no release work is
  left only under `Unreleased`.
- [ ] Documentation, screenshots, and demo media describe the release behavior.
- [ ] License files, project links, and package metadata are current.

## Security and Privacy

- [ ] Review changes to imports, paths, raw JSON, Team bundles, persistence,
  browser-origin controls, and network binding.
- [ ] Search tracked files for credentials, tokens, private paths, and raw user
  exports.
- [ ] Run `uv run --locked --extra dev --with pip-audit pip-audit` from `backend/`
  so the audit includes test dependencies as well as runtime dependencies.
- [ ] Run `npm audit --audit-level=moderate` from `frontend/`.
- [ ] Confirm synthetic fixtures and screenshots contain no private data.

## Verification

- [ ] Backend tests pass on Python 3.11, 3.12, and 3.13.
- [ ] Frontend build and tests pass from a clean `npm ci --ignore-scripts`.
- [ ] `docker compose config -q` passes.
- [ ] `git diff --check` reports no whitespace errors.
- [ ] CI's package smoke job builds the sdist and wheel, verifies bundled UI and
  data assets, installs the wheel, and reads its packaged version/assets.
- [ ] Test the installed CLI from the candidate wheel on loopback.

## Publish

- [ ] Create tag `vX.Y.Z` on the release PR's resulting commit on `main` after
  all required CI checks pass. If the tag was created early and exists only
  locally, confirm it is absent from the remote and move it to this commit
  before pushing it.
- [ ] Create and review the GitHub release notes before publishing the release.
- [ ] After publication, verify the PyPI files and run a fresh
  `uvx checkyouragent@X.Y.Z --help` smoke test.
