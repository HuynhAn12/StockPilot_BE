process.env.APP_TIMEZONE = process.env.APP_TIMEZONE || 'Asia/Ho_Chi_Minh';
// Tests never call the real OpenAI API, even when a developer has OPENAI_API_KEY in .env.
// dotenv does not override variables that are already set, so this wins over .env.
process.env.AI_ENABLED = 'false';
