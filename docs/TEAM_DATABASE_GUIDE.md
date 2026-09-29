# Team Database Guide

This project should use one shared local app database name and one separate test database name.

## Standard Database Names

- App/development database: `stockpilot`
- Automated test database: `stockpilot_test`

Do not use old temporary schemas such as `stockpilot_dev`, `stockpilot_phase1_migrate_test`, or `stockpilot_v11_migrate_test` for normal development.

## Local `.env`

Use this convention in your local `.env`:

```env
DATABASE_URL="mysql://<user>:<password>@127.0.0.1:3306/stockpilot"
TEST_DATABASE_URL="mysql://<user>:<password>@127.0.0.1:3306/stockpilot_test"
```

Never commit `.env`. It is intentionally ignored by git.

## App Database Setup

Use the app database for running the backend normally:

```bash
npm ci
npm run prisma:generate
npm run prisma:migrate:deploy
npm run dev
```

If `stockpilot` already has tables but no Prisma migration history, ask before resetting or dropping it. The safe path is to baseline existing migrations, then apply only new migrations.

## Test Database

`stockpilot_test` is disposable. Integration tests may clean up and seed data there.

```bash
npm test
```

Do not point `TEST_DATABASE_URL` at `stockpilot`, production, or any shared data schema.

## Cleaning Old Local Schemas

Only delete old schemas after confirming nobody needs their data. Recommended manual flow:

1. Back up any schema that may contain useful data.
2. Confirm the app works against `stockpilot`.
3. Confirm tests work against `stockpilot_test`.
4. Drop old temporary schemas manually from MySQL Workbench or CLI.

Do not drop schemas from automation unless the target is explicitly confirmed.
