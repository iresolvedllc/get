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
is the liveness check and `GET /healthz/deep` also verifies the database
(cached in isolate memory for 10s).

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
Bodies over 1 MiB are rejected before being read.

QStash retries every non-2XX response, so permanent rejections — malformed
payloads, unknown channels, refused downgrades — are answered with
**489 + `Upstash-NonRetryable-Error: true`**, which sends the message straight
to the dead-letter queue instead of retrying it. Only 5xx responses (storage
or database trouble) are retried; a rate-limited publish carries `Retry-After`
so QStash reschedules the delivery rather than burning an attempt.

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

`.env` at the repository root is untracked. Product-owned variables use the
`GET_` prefix; the shared QStash variables do not. `scripts/dev-vars.ts`
generates `.dev.vars` from it for `wrangler dev`, and CI receives the same
values as Depot secrets.

| `.env` | Worker binding |
| --- | --- |
| `GET_DATABASE_URL` | `DATABASE_URL` (pooled endpoint) |
| `GET_AWS_ACCESS_KEY_ID` | `AWS_ACCESS_KEY_ID` |
| `GET_AWS_SECRET_ACCESS_KEY` | `AWS_SECRET_ACCESS_KEY` |
| `GET_AWS_REGION` | `AWS_REGION` |
| `GET_AWS_ENDPOINT_URL_S3` | `AWS_ENDPOINT_URL_S3` |
| `GET_S3_BUCKET` | `S3_BUCKET` |
| `GET_UPSTASH_REDIS_REST_URL` | `UPSTASH_REDIS_REST_URL` |
| `GET_UPSTASH_REDIS_REST_TOKEN` | `UPSTASH_REDIS_REST_TOKEN` |
| `QSTASH_CURRENT_SIGNING_KEY` | `QSTASH_CURRENT_SIGNING_KEY` |
| `QSTASH_NEXT_SIGNING_KEY` | `QSTASH_NEXT_SIGNING_KEY` |

`QSTASH_URL` and `QSTASH_TOKEN` are used by CI to publish. The Worker only
verifies signatures. `GET_DATABASE_URL_DIRECT` and `GET_REDIS_URL` are kept for
manual tooling and are unused by the Worker. `GET_NEON_AI_GATEWAY_*` is
reserved for upcoming security work (JEV verification and an IP reputation
database) and is not read by the Worker in v1.

Wrangler vars are in `wrangler.jsonc`: `PRESIGN_TTL_SECONDS` and
`CANONICAL_ORIGIN`. The `IP_RATE_LIMIT` rate-limit binding and the nightly
cron are declared there too.

## Rate limiting

Two independent layers, both keyed on `CF-Connecting-IP`:

1. `IP_RATE_LIMIT`, a Cloudflare rate-limit binding — a coarse fixed window of
   60 requests/minute per IP enforced at the edge. It has no external
   dependency and keeps protecting the service when Upstash Redis is
   unreachable.
2. Sliding windows in Upstash Redis (`src/lib/ratelimit.ts`): update/download
   30/min, install 20/min, publish 30/min per IP.

Exhausted windows get `429` with `Retry-After` and `X-RateLimit-*` headers
(plain-text bodies on install routes, JSON elsewhere). When Redis is
unreachable the sliding windows fail **closed** with `503` — the service
prefers to appear unavailable rather than run without abuse protection; the
edge binding keeps its coarse cap either way. Without the Redis bindings
(`wrangler dev` without `.dev.vars`, tests) the sliding-window layer is
disabled and only the edge binding applies.

## Caching

`GET /` is cached at the edge for 5 minutes. Update and download responses are
cached for 60 seconds with `stale-while-revalidate=300` — safe because
presigned URLs stay valid for `PRESIGN_TTL_SECONDS` (900 by default, clamped
to 60–3600). Publish, install, and every error response are `no-store`.

## Local development

```console
$ bun install
$ bun run migrate
$ bun run dev
```

`bun run dev` maps `.env` into a gitignored `.dev.vars` (via
`scripts/dev-vars.ts`) and starts `wrangler dev` on http://127.0.0.1:8787.
Use `bun run dev-vars` to regenerate `.dev.vars` without starting wrangler.

Tests:

```console
$ bun run test
$ bun run typecheck
```

The integration tests use the `.env` bindings (through `.dev.vars`) when they
are present. They publish to the `beta` channel and restore the previous head
afterwards. The rate-limit sliding windows are disabled in tests; only the
edge binding applies.

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
runs typecheck and tests, applies migrations, deploys the worker, and publishes
the secrets (add them with `depot ci secrets add <NAME>` in the org).

The custom domain is declared in `infra/terraform/workers.tf` as
`cloudflare_workers_domain.get`. The worker script is named `get-unified` so it
does not overwrite the old Build worker while the cutover is in progress.
Deploy the worker before applying the domain: Cloudflare will not attach a
hostname to a script that does not exist.
