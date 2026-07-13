// Keyless provider for local development and CI. Enabled with MOCK_AI=1 or
// by requesting provider "mock" explicitly. Echoes a deterministic response
// shaped like a real one so downstream ACU metering and routing are testable.

export async function generate(req) {
  const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
  const prompt = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '');

  const text = req.jsonSchema
    ? JSON.stringify({ mock: true, prompt: prompt.slice(0, 120) })
    : `[mock] Venture analysis for: ${prompt.slice(0, 120)}`;

  return {
    provider: 'mock',
    model: 'mock-1',
    text,
    stopReason: 'end_turn',
    usage: { inputTokens: Math.ceil(prompt.length / 4), outputTokens: Math.ceil(text.length / 4) },
  };
}
