import { applyD1Migrations, env, type D1Migration } from 'cloudflare:test';

// Applies apps/edge/migrations to the test USERS_DB (idempotent: applied migrations are recorded).
const testEnv = env as unknown as { USERS_DB: D1Database; TEST_MIGRATIONS: D1Migration[] };
await applyD1Migrations(testEnv.USERS_DB, testEnv.TEST_MIGRATIONS);
