/**
 * Imported first by the self-test, so it runs before any module under test.
 *
 * `loadConfig()` copies the working directory's `.env` into `process.env`, and
 * a developer's `.env` holds real credentials - a production database URL, the
 * GitHub App's private key. Tests must never reach those, so the file is not
 * read, and the variables that switch Docxy onto real services are cleared in
 * case the shell exported them.
 */
process.env.DOCXY_NO_DOTENV = '1';
for (const name of [
  'DATABASE_URL',
  'DOCXY_API_TOKEN',
  'GITHUB_APP_ID',
  'GITHUB_APP_INSTALLATION_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_PRIVATE_KEY_PATH',
  'GITHUB_WEBHOOK_SECRET',
  'DAYTONA_API_KEY',
  'NEBIUS_API_KEY',
  'TYPESAFE_API_KEY',
  'COMPOSIO_API_KEY',
]) {
  delete process.env[name];
}
