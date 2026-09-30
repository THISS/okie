-- CLA-316: one row per GitHub user who has signed in to sourcefor.dev.
-- email is GitHub's primary verified address at the last sign-in (NULL when there is none).
-- privacy_version is the privacy policy version in force at sign-up (PRIVACY_POLICY_VERSION, apps/web/src/siteMeta.ts).
-- Signing in never implies marketing consent: product_updates_opt_in starts at 0 and only the account page's
-- form changes it (product_updates_changed_at records when it last changed).
CREATE TABLE users (
  github_id INTEGER PRIMARY KEY,
  github_login TEXT NOT NULL,
  email TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_sign_in_at TEXT NOT NULL,
  privacy_version TEXT NOT NULL,
  product_updates_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (product_updates_opt_in IN (0, 1)),
  product_updates_changed_at TEXT
);
