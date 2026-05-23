import type { ChatOptions } from "./common.js";

export async function chatChatgpt(
	systemMsg: string,
	userMsg: string,
	apiKey: string,
	model: string,
	opts: ChatOptions = {},
): Promise<string> {
	const OpenAI = (await import("openai")).default;
	const client = new OpenAI({ apiKey });

	const res = await client.chat.completions.create({
		model,
		temperature: opts.temperature ?? 0.5,
		max_tokens: opts.maxTokens ?? 8192,
		response_format: opts.jsonMode ? { type: "json_object" } : undefined,
		messages: [
			{ role: "system", content: systemMsg },
			{ role: "user", content: userMsg },
		],
	});

	return res.choices[0]?.message?.content ?? "";
}
