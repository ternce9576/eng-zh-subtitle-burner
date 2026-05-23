import type { ChatOptions } from "./common.js";

export async function chatGemini(
	systemMsg: string,
	userMsg: string,
	apiKey: string,
	model: string,
	opts: ChatOptions = {},
): Promise<string> {
	const { GoogleGenerativeAI } = await import("@google/generative-ai");
	const genAI = new GoogleGenerativeAI(apiKey);
	const genModel = genAI.getGenerativeModel({ model });

	const result = await genModel.generateContent({
		systemInstruction: systemMsg,
		contents: [{ role: "user", parts: [{ text: userMsg }] }],
		generationConfig: {
			temperature: opts.temperature ?? 0.5,
			maxOutputTokens: opts.maxTokens ?? 8192,
			...(opts.jsonMode ? { responseMimeType: "application/json" } : {}),
		},
	});

	return result.response.text();
}
