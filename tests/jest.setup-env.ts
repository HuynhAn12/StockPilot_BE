process.env.APP_TIMEZONE = process.env.APP_TIMEZONE || 'Asia/Ho_Chi_Minh';
// Tests never call the real OpenAI API, even when a developer has OPENAI_API_KEY in .env.
// dotenv does not override variables that are already set, so this wins over .env.
process.env.AI_ENABLED = 'false';
// Pin the provider so a developer's AI_PROVIDER in .env cannot change which API shape tests exercise.
process.env.AI_PROVIDER = 'openai';
// Pin the tenant root domain: tenant tests use *.stockpilot.vn hostnames, and the code default follows
// the deployment domain (changed to stockpilot.name.vn), so tests must not depend on it.
process.env.TENANT_ROOT_DOMAIN = 'stockpilot.vn';
