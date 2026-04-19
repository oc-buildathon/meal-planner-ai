export default () => ({
  port: parseInt(process.env.PORT ?? "3000", 10),

  // Deep Agent model — uses "provider:model" format (e.g. "openai:gpt-4o", "anthropic:claude-sonnet-4-6")
  // The provider's API key env var must also be set (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.)
  agent: {
    model: process.env.AGENT_MODEL ?? "openai:gpt-4o",
  },

  // LLM — OpenAI-compatible endpoint (fallback, used when agent is not initialized)
  llm: {
    baseUrl: process.env.LLM_BASE_URL ?? "https://api.openai.com/v1",
    apiKey: process.env.LLM_API_KEY ?? "",
    model: process.env.LLM_MODEL ?? "gpt-4o",
  },

  // WhatsApp (Baileys)
  whatsapp: {
    enabled: process.env.WHATSAPP_ENABLED === "true",
    sessionId: process.env.WHATSAPP_SESSION_ID ?? "mealprep-bot",
    authDir: process.env.WHATSAPP_AUTH_DIR ?? "./auth_sessions",
    // Optional: set phone number for pairing code auth (e.g. "919876543210")
    // If not set, QR code auth is used
    phoneNumber: process.env.WHATSAPP_PHONE_NUMBER ?? "",
  },

  // Telegram
  telegram: {
    enabled: process.env.TELEGRAM_ENABLED === "true",
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  },
});
