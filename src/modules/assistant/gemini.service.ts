/**
 * Gemini Service facade for StockPilot AI assistant.
 * Re-exports AiDecisionService and OpenAiClient for compatibility with gemini service naming.
 */
import { AiDecisionService } from './ai-decision.service';
import { OpenAiClient } from './llm/openai-client';
import { aiMemoryService, AiMemoryService } from './ai-memory.service';

export { AiDecisionService, AiDecisionService as GeminiService, OpenAiClient, aiMemoryService, AiMemoryService };
export default AiDecisionService;
