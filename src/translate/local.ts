import type { ChatOptions } from "./common.js";

export async function chatLocal(
	systemMsg: string,
	userMsg: string,
	ollamaUrl: string,
	model: string,
	opts: ChatOptions = {},
): Promise<string> {
	const body: Record<string, unknown> = {
		model,
		messages: [
			{ role: "system", content: systemMsg },
			{ role: "user", content: userMsg },
		],
		stream: false,
		options: {
			temperature: opts.temperature ?? 0.5,
			num_ctx: 8192,
			num_predict: opts.maxTokens ?? -1,
		},
	};
	if (opts.jsonMode) body.format = "json";

	const res = await fetch(`${ollamaUrl}/api/chat`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

	if (!res.ok) {
		throw new Error(`Ollama error: ${res.status} ${await res.text()}`);
	}

	const data = (await res.json()) as { message: { content: string } };
	return data.message.content;
}
