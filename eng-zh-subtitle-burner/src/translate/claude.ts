import type { ChatOptions } from "./common.js";

export async function chatClaude(
	systemMsg: string,
	userMsg: string,
	apiKey: string,
	model: string,
	opts: ChatOptions = {},
): Promise<string> {
	const Anthropic = (await import("@anthropic-ai/sdk")).default;
	const client = new Anthropic({ apiKey });

	const messages: { role: "user" | "assistant"; content: string }[] = [
		{ role: "user", content: userMsg },
	];
	if (opts.jsonMode) {
		messages.push({ role: "assistant", content: "{" });
	}

	const msg = await client.messages.create({
		model,
		max_tokens: opts.maxTokens ?? 8192,
		temperature: opts.temperature ?? 0.5,
		system: systemMsg,
		messages,
	});

	let text = msg.content
		.filter((b) => b.type === "text")
		.map((b) => (b as { text: string }).text)
		.join("");

	if (opts.jsonMode) text = "{" + text;
	return text;
}
