set shell := ["bash", "-euo", "pipefail", "-c"]

setup:
    bun install

dev:
    bun run dev

build:
    bun run build

deploy:
    bun run deploy

migrate:
    bun run migrate

typecheck:
    bun run typecheck

test:
    bun run test

seed-build-tool:
    bun run seed-build-tool
