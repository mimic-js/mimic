# Releasing `@mimic-js/runtime`

Releases are made with `nx release`, configured under `release` in
[`nx.json`](../nx.json), and run by the manually dispatched
[`Release` workflow](../.github/workflows/release.yml). Only the `runtime`
project (`packages/runtime`, published as `@mimic-js/runtime`) is released.
`apps/site` and `apps/e2e-demo` are private and never versioned or
published.

## What a release does

1. **Version.** The current version is read from the latest `v*` git tag. For
   the first release, when no tag exists yet, it is read from
   `packages/runtime/package.json` (`--first-release` turns on that
   fallback). Nx works out the next version from the specifier, or from the
   conventional commits since the tag when no specifier is given, and writes
   it to `packages/runtime/package.json`. It also runs
   `pnpm install --lockfile-only`.
2. **Changelog.** It prepends an entry to `packages/runtime/CHANGELOG.md`.
   The changelog belongs to the package, not the workspace, so commits that
   change only files of `apps/site` or `apps/e2e-demo` stay out of it.
   A commit that also touches a file outside every project, such as `docs/`,
   `.github/` or a root config file, is listed in it (that is how Nx's
   default renderer attributes such files). Nx creates the file on the first
   release.
3. **Commit, tag, push.** It commits `chore(release): publish <version>`, tags
   it `v<version>` (an annotated tag), and pushes both to `main` with
   `git push --follow-tags --atomic`. Nx always pushes when it creates a
   GitHub release, because the release needs the tag on the remote. With
   `--atomic`, if `main` moved during the run, nothing is pushed and the run
   fails before it publishes.
4. **GitHub release.** It creates a GitHub release for `v<version>` whose body
   is the changelog entry.
5. **Publish.** `nx release publish` runs the `nx-release-publish` target
   that `@nx/js` adds to every non-private package. The target runs
   `pnpm publish packages/runtime --access public --tag <tag>`. pnpm's
   `prepack` runs `package:check` again, so the tarball is always built from
   the tagged commit.

The workflow runs steps 1 to 4 as `nx release [specifier] --skip-publish`,
then step 5 as a separate step. It publishes only when a `v<version>` tag
points at `HEAD`. When conventional commits find nothing to release, Nx makes
no commit or tag, so the workflow publishes nothing.

## How commits decide the version

The bump comes from the [Conventional Commits](https://www.conventionalcommits.org/)
type of each commit since the last tag that affects the runtime in the
`nx affected` sense. That means files under `packages/runtime`, or workspace
inputs such as `nx.json` or the runtime's entries in the lockfile. A commit
that touches only `docs/` or `apps/` never bumps the version:

| Commit | Bump from 1.0.0 onwards | Bump while the version is 0.x |
| --- | --- | --- |
| `fix:` or `perf:` | patch | patch |
| `feat:` | minor | patch |
| `feat!:`, `fix!:`, or a `BREAKING CHANGE:` footer | major | minor |
| `docs:`, `chore:`, `refactor:`, `test:`, `ci:`, `build:`, `style:`, `revert:` | none | none |

The 0.x column follows SemVer's rule that anything may change before 1.0:
`release.version.adjustSemverBumpsForZeroMajorVersion` (Nx's default, set
explicitly in `nx.json`) moves a breaking change down to a minor bump and a
feature down to a patch bump. A breaking change therefore never makes
`0.x` into `1.0.0`. To release 1.0.0, run the workflow with the specifier
`1.0.0` or `major`; explicit specifiers are never adjusted. Nx has no
`preserveMajor` setting. `versionPrefix` is unrelated: it sets the range
prefix written into dependents.

Scopes are free-form (`feat(vfs): …`, `fix(node-compatibility): …`).
`release.conventionalCommits.useCommitScope` is `false`, so a scope that does
not name the `runtime` project still bumps the version normally. `perf:` is
raised from Nx's default of no bump to a patch bump. Release commits
(`chore(release): …`) are ignored. Changelog sections are Features, Fixes,
Performance and Breaking Changes. Other types are hidden.

## The first release

`0.1.0` was released on 2026-10-11 with the specifier `0.1.0` and
**first-release** checked. The specifier was needed: the history already held
breaking `feat!:` commits, so conventional commits would have chosen 0.2.0.
Its changelog entry lists site-only commits under the runtime's features,
because they touched root files (`README.md`, `assets/`, the lockfile); a
later commit may trim `CHANGELOG.md`, and the GitHub release text can be
edited in place.

## Later releases

Run the workflow on `main` with **specifier** left empty, so the version comes
from commits, or set it to `patch`, `minor`, `major`, or an exact version.
Leave **first-release** unchecked.

Prereleases: the specifiers `prerelease`, `prepatch`, `preminor` and
`premajor` produce versions like `0.1.1-0`. The workflow publishes any version
containing `-` under the npm dist-tag `next` instead of `latest`.

### Staged publishing

npm may accept a publish into its staged queue instead of publishing it
directly: a new package, or a token without the right to publish past 2FA,
goes there. The workflow cannot tell the difference, since `pnpm publish`
reports success either way, and for a new package the registry shows a
public placeholder version `0.0.0-stage` (the `0.1.0` publish went this way,
which is why that placeholder exists). The real version is installable only
once a maintainer approves it with 2FA:

```sh
pnpm login
pnpm stage list @mimic-js/runtime
pnpm stage approve <stage-id>
```

So after every run, check `npm view @mimic-js/runtime version dist-tags`. A
staged version keeps its number: do not rerun the workflow with
**publish-only** to "retry" it, approve or reject it instead. Trusted
publishing (below) publishes directly.

If versioning succeeded but publishing failed, rerun the workflow with
**publish-only** checked. This only works while the release commit is still the head
of `main`. If other commits have landed since, publish from a checkout of the
tag by running `pnpm exec nx release publish` with `NODE_AUTH_TOKEN` set.

## Secrets and settings

| Where | What |
| --- | --- |
| npmjs.com | The organisation `mimic-js`, which owns the `@mimic-js` scope. It must exist before the first publish. |
| npmjs.com | A **granular access token**: *Packages and scopes → Read and write*, limited to the `@mimic-js` scope (or the organisation `mimic-js`). It must be allowed to publish without 2FA prompts, which is what npm's "automation"/bypass-2FA option is for; without it, every publish lands in the [staged queue](#staged-publishing). Give it the shortest expiry you are happy to rotate. |
| GitHub repository secret `NPM_TOKEN` | That token. The workflow passes it to pnpm as `NODE_AUTH_TOKEN`, through the `.npmrc` that `actions/setup-node` writes. |
| GitHub repository secret `RELEASE_TOKEN` (optional) | Needed only if a branch protection rule or ruleset on `main` rejects direct pushes from `GITHUB_TOKEN`. Use a GitHub App installation token or a fine-grained PAT with *Contents: read and write* on `mimic-js/mimic`, and add that actor to the rule's bypass list. When the secret is absent, the workflow uses `GITHUB_TOKEN`. |

The workflow asks for its own permissions (`contents: write` for the push and
the GitHub release, `id-token: write` for provenance), so the repository's
default workflow permissions can stay read-only.

A push made with `GITHUB_TOKEN` does not start other workflows, so the
release commit does not trigger `ci.yml`. A push made with `RELEASE_TOKEN`
does start `ci.yml`'s `push` jobs (build and unit tests) on the release
commit. That is harmless: the commit only changes the version, the changelog
and possibly the lockfile.

### Provenance

`nx release publish` publishes with `pnpm publish`. pnpm 11 reads settings
from `PNPM_CONFIG_*` environment variables. It does not read
`NPM_CONFIG_PROVENANCE` (`pnpm config get provenance` prints `undefined` with
it set, and `true` with `PNPM_CONFIG_PROVENANCE=true`), so the workflow sets
`PNPM_CONFIG_PROVENANCE=true`. It also sets
`NPM_CONFIG_PROVENANCE=true` for any npm CLI that runs. Provenance needs
`id-token: write`, a public repository, and `--access public` (set for the
`nx-release-publish` target in `nx.json`'s `targetDefaults`, and in
`publishConfig.access`).

### Moving to npm trusted publishing (OIDC) after the first release

Trusted publishing replaces `NPM_TOKEN` with a short-lived token that npm
issues to this workflow alone. pnpm 11 exchanges the GitHub OIDC token for it
on its own and adds provenance automatically.

1. On npmjs.com, open `@mimic-js/runtime` → **Settings → Trusted Publisher**,
   choose **GitHub Actions**, and enter organisation `mimic-js`, repository
   `mimic`, workflow filename `release.yml`. Leave the environment empty
   unless you add one to the job.
2. Run a release to confirm it works, then delete the `NPM_TOKEN` secret and
   revoke the token. With the secret gone, `NODE_AUTH_TOKEN` is empty and
   pnpm uses OIDC.
3. Optionally, under the package's **Publishing access**, require 2FA and
   disallow tokens, so only the trusted workflow can publish.

## Dry runs on your machine

From the repository root:

```sh
# What the next release would do (fetch tags first: git fetch --tags)
pnpm run release:dry-run
pnpm run release:dry-run minor

# The resolved configuration
pnpm exec nx release --printConfig=debug

# What would be published (builds the package and lists the tarball)
pnpm exec nx release publish --dry-run
```

`release:dry-run` prints the version change, the changelog entry and the git
commands. It changes nothing on disk. If it fails with "Unable to determine
the previous git tag", the tags are not fetched.

`release.git` is set in `nx.json` for the top-level `nx release` command.
Because of that, Nx refuses to run the `nx release version` and
`nx release changelog` subcommands on their own. Use `nx release` (with
`--skip-publish` or `--dry-run`) and `nx release publish`.

Do not run `pnpm run release` locally except to recover from a failed run. It
commits, tags, pushes to `origin` and creates the GitHub release. Locally it
needs `GITHUB_TOKEN` or `gh auth login`.
