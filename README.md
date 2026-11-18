# get

Unified release, update and install API for the iResolved products. It is a
Cloudflare Worker written with Hono, backed by Neon Postgres and Neon Object
Storage, with QStash delivering publish events.

The service is deployed at **https://get.iresolved.link**.

## Products

| Product | Install | Update |
| --- | --- | --- |
| Build | `curl -fsSL https://get.iresolved.link/build/install \| bash` | `/build/v1/update` |
| build-tool | `curl -fsSL https://get.iresolved.link/build-tool/install \| bash` | `/build-tool/v1/update` |
| Kiln | `curl -fsSL https://get.iresolved.link/kiln/install \| sh` | `/kiln/v1/update` |
| Kiln (Windows) | `irm https://get.iresolved.link/kiln/install.ps1 \| iex` | `/kiln/v1/update` |

`GET /` lists the registry, including channels and platforms. `GET /healthz`
is the liveness check.

## API

### Update

```console
$ curl -s 'https://get.iresolved.link/build/v1/update?channel=stable&platform=linux-x86_64'
```

Query parameters:

| Name | Meaning |
| --- | --- |
| `channel` | Product channel. Defaults to `stable`. |
| `version` | Version the caller already has. Drives `update`. |
| `target` | Describe one exact version instead of the channel head. |
| `platform` | Product platform. Defaults to the product's primary platform. |
| `format` | `json` (default), `text`, or `plain`. |
| `debug` | `1` includes debug artifacts where the product has them. |

The response is the Build v1 contract extended with `product`:

```json
{
  "product": "build",
  "update": true,
  "current": "1.0.37",
  "latest": "1.0.38",
  "channel": "stable",
  "platform": "linux-x86_64",
  "url": "https://...",
  "sha256": "...",
  "size": 41211234,
  "notes": null,
  "published_at": "2026-10-25T12:00:00Z",
  "artifacts": [
    { "platform": "linux-x86_64", "kind": "raw", "url": "https://...", "sha256": "...", "size": 41211234 }
  ],
  "metadata": {}
}
```

`format=text` is the line-oriented form used by the shell installers. It needs
no `jq` or `python3`. `format=plain` returns only `latest\n`.

`GET /<product>/v1/download` redirects to the primary artifact. It accepts the
same `channel`, `version`, `target`, and `platform` parameters.

### Install

Install and update links are rendered per request, never stored in the bucket.
The script resolves a current presigned URL at install time. Non-loopback
requests always use the canonical origin, so a forged Host header cannot change
the URL a script trusts.

### Publish

QStash delivers to `POST /<product>/v1/publish`. The Worker verifies the
`upstash-signature` header against the raw body with the current and next
signing keys, then validates the payload and the objects in the bucket.

```json
{
  "channel": "stable",
  "version": "1.0.38",
  "notes": "optional",
  "rollback": false,
  "metadata": { "commit": "abc123" },
  "artifacts": [
    {
      "platform": "linux-x86_64",
      "kind": "raw",
      "object_key": "build/stable/1.0.38/linux-x86_64/raw/build-1.0.38-linux-x86_64",
      "sha256": "64 lowercase hex characters",
      "size": 41211234,
      "content_type": "application/octet-stream"
    }
  ]
}
```

The server derives the only permitted object key from the product definition.
Every object must already exist at the declared size. A release replaces the
artifact set for that version and moves the channel head in one transaction.
`stable` and `beta` refuse to move backwards unless `rollback` is true;
unordered tracks such as `nightly` and `canary` accept any version.

Object layout:

```text
<product>/<channel>/<version>/<platform>/<kind>/<filename>
```

Publishing through QStash:

```console
$ curl --fail-with-body -X POST \
    "$QSTASH_URL/v2/publish/https://get.iresolved.link/build/v1/publish" \
    -H "Authorization: Bearer $QSTASH_TOKEN" \
    -H "Content-Type: application/json" \
    -H "Upstash-Retries: 5" \
    --data-binary @payload.json
```

## Adding a product

1. Add `src/products/<slug>.ts` with its channels, platforms, artifact kinds,
   version rules, and installers.
2. Register it in `src/products/index.ts`.
3. Add a migration that inserts the product and channel rows.
4. Add the platform definitions to the installer if the product needs them.

The routes, storage layout, and publish handler do not change.

## Environment

`.env.get` at the repository root is untracked. Product-owned variables use the
`GET_` prefix; the shared QStash variables do not.

| `.env.get` | Worker binding |
| --- | --- |
| `GET_DATABASE_URL` | `DATABASE_URL` |
| `GET_AWS_ACCESS_KEY_ID` | `AWS_ACCESS_KEY_ID` |
| `GET_AWS_SECRET_ACCESS_KEY` | `AWS_SECRET_ACCESS_KEY` |
| `GET_AWS_REGION` | `AWS_REGION` |
| `GET_AWS_ENDPOINT_URL_S3` | `AWS_ENDPOINT_URL_S3` |
| `GET_S3_BUCKET` | `S3_BUCKET` |
| `QSTASH_CURRENT_SIGNING_KEY` | `QSTASH_CURRENT_SIGNING_KEY` |
| `QSTASH_NEXT_SIGNING_KEY` | `QSTASH_NEXT_SIGNING_KEY` |

`QSTASH_URL` and `QSTASH_TOKEN` are used by CI to publish. The Worker only
verifies signatures. `GET_NEON_REALTIME_*` is not used in v1.

Wrangler vars are in `wrangler.jsonc`: `PRESIGN_TTL_SECONDS` and
`CANONICAL_ORIGIN`.

## Local development

```console
$ bun install
$ bun run migrate
$ bun run dev
```

`bun run dev` maps `.env.get` into a gitignored `.dev.vars` and starts
`wrangler dev` on http://127.0.0.1:8787.

Tests:

```console
$ bun run test
$ bun run typecheck
```

The integration tests use the `.env.get` bindings when they are present. They
publish to the `beta` channel and restore the previous head afterwards.

## Seeding build-tool

The build-tool binary is a separate project in the iResolved monorepo. Point
`BUILD_TOOL_BINARY` at it (default `tools/build-tool`), then upload it and move the
`build-tool/stable` head with:

```console
$ bun run seed-build-tool
```

The script writes the binary and a `SHA256SUMS` object, records S3 metadata
(`sha256`, `commit`, `version`, `binary_version`), and calls the same publish
path the Worker uses.

## Deployment

```console
$ just deploy
```

The worker's secrets are the values in the table above. `.depot/workflows/deploy.yml`
applies migrations, deploys the worker, and publishes the secrets.

The custom domain is declared in `infra/terraform/workers.tf` as
`cloudflare_workers_domain.get`. The worker script is named `get-unified` so it
does not overwrite the old Build worker while the cutover is in progress.
Deploy the worker before applying the domain: Cloudflare will not attach a
hostname to a script that does not exist.
