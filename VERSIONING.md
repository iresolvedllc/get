# Versioning

In-house units use a four-number version so the repository can absorb the commit volume from people and agents. The commit hash identifies the source commit. The build number orders artifacts. Semantic Versioning remains only for dependencies we explicitly fetch, and for the `version` field of tools that reject this grammar.

This applies to every project, product, and service in the get repository, including ones added later.

## Published form

```
<epoch>.<major>.<minor>.<build>[-rc.<N>.<M>]-<channel>-<sha>
```

`1.3.0.40-nightly-e8dff7365b69e8dff7365b69e8dff7365b69e8df` is a nightly build.

`2.0.0.1-rc.1.0-stable-e8dff7365b69e8dff7365b69e8dff7365b69e8df` is the first release candidate of an epoch or major cut.

Rules:

- No `v` prefix.
- No leading zeros. `0` is the only number that may be a single zero.
- `channel` is `stable`, `beta`, `alpha`, or `nightly`.
- `sha` is the full 40-character lowercase hex SHA-1 of the repository commit the artifact was built from.
- `rc` is optional. `N` is the candidate. `M` is a rebuild of that candidate.
- `rc` is present only on an epoch or major release.
- `1.0.38.1`, `v1.3.0.40-nightly-<sha>`, and `1.3.0.40-push-<sha>` are not versions in this scheme.

Push is the trigger that produces a nightly build. It is not a channel name.

## Fields

| Field | Meaning | Who sets it | On bump |
| --- | --- | --- | --- |
| `epoch` | One closed collection of breaking changes. It increments when that collection is finished and the next one starts. | A person runs the release script. | Resets `major`, `minor`, and `build` to 0. Writes the changelog. |
| `major` | One accepted breaking change inside the open epoch. A break ships to consumers on a major bump. | A person runs the release script. | Resets `minor` and `build` to 0. Writes the changelog. |
| `minor` | A non-breaking patch: security, reliability, or another correction that does not add a feature or a break. | The security-patch script. | Resets `build` to 0. Writes the changelog entry for that patch. Does not change `epoch` or `major`. |
| `build` | The count of commits that changed this unit since the higher fields last moved. | The pre-commit hook, for each in-house unit the commit touches. | Increments by 1. Does not change `epoch`, `major`, or `minor`. |
| `rc` | Marks an epoch or major release that is still a candidate. | CI, when it publishes that release. | Not stored in `.version`. The hook does not write it. |
| `channel` | The track this artifact was published to. | CI, when it publishes. | Not stored in `.version`. The hook does not write it. |
| `sha` | The repository commit that produced the artifact. | CI, when it publishes. | Not stored in `.version`. A pre-commit hook cannot know it, because the commit does not exist yet. |

Alpha, beta, and nightly may contain work that will later break. That break is not a contract until `major` increments.

Each unit has its own `epoch.major.minor.build`. Two units built from the same commit may carry different numbers. The hash is always the repository commit.

## `.version`

Each releasable unit has a `.version` file at that unit's root. CI reads it. The file is one line:

```
epoch.major.minor.build
```

`crates/config/.version` containing `1.3.0.40` publishes as `1.3.0.40-nightly-<40-hex>` when CI stamps the channel and the hash. `base/` does not share one file across its crates. `third_party/` has no `.version`.

Cargo and npm reject a fourth numeric field. The `version` field in `Cargo.toml` and `package.json` stays a value those tools accept. `.version` is the in-house version.

## Order

Compare versions only within one channel. Order is `epoch`, then `major`, then `minor`, then `build`, compared as integers. The hash does not affect order.

If the four numbers are equal, a version without `rc` is newer than a version with `rc`. Two `rc` versions compare `N`, then `M`.

`1.3.0.40-nightly-<sha>` is newer than `1.3.0.39-nightly-<sha>` on nightly. It says nothing about what stable has shipped.

## Cadence

These rates are targets, not gates.

| Channel | Target |
| --- | --- |
| `stable` | Once or twice a week |
| `beta` | Once or twice a week |
| `alpha` | About once a day |
| `nightly` | On each push, as often as pushes happen |

A missed week does not block nightly. Extra builds are allowed. Uniqueness comes from the build number and the hash.

## Promotion

How an artifact moves between `stable`, `beta`, `alpha`, and `nightly` is decided per release. The criteria are not part of this document. Until they exist, channel is a label CI applies. The hook and `.version` do not change it.

## What stays on semantic versioning

A dependency we explicitly fetch keeps the upstream semantic version. Units under `third_party/` keep the version they arrived with. Everything we maintain in this repository uses the grammar above.
