import type { GenerationConfig } from "@google/generative-ai";
import type { ChatOptions } from "./common.js";

const RETRYABLE_STATUS = new Set([429, 500, 503, 504]);
const MAX_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function statusOf(err: unknown): number | undefined {
	const e = err as { status?: number; statusCode?: number } | undefined;
	return e?.status ?? e?.statusCode;
}

export async function chatGemini(
	systemMsg: string,
	userMsg: string,
	apiKey: string,
	model: string,
	opts: ChatOptions = {},
): Promise<string> {
	const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } =
		await import("@google/generative-ai");
	const genAI = new GoogleGenerativeAI(apiKey);
	const genModel = genAI.getGenerativeModel({
		model,
		// Gaming subtitle content routinely hits mild profanity, trash talk,
		// and slang (卧槽, 破防, 送了...) that Gemini's default thresholds can
		// flag and block outright, silently killing a batch. This is a
		// translation pipeline for content that already exists in the source
		// language — loosen the categories that misfire on that, not the
		// ones covering genuinely unsafe content.
		safetySettings: [
			{
				category: HarmCategory.HARM_CATEGORY_HARASSMENT,
				threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
			},
			{
				category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
				threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
			},
			{
				category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
				threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
			},
			{
				category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
				threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
			},
		],
	});

	// Built loosely-typed (opts.schema is a plain object literal from
	// common.ts, not the SDK's nominally-typed Schema/SchemaType) and cast at
	// the call site below — the SDK only cares about the JSON shape at
	// runtime, but its TS types are stricter than that.
	const generationConfig: GenerationConfig = {
		temperature: opts.temperature ?? 0.5,
		maxOutputTokens: opts.maxTokens ?? 8192,
		...(opts.jsonMode ? { responseMimeType: "application/json" } : {}),
		// Controlled generation: constrains decoding to the schema directly
		// instead of relying on prompt instructions alone, so batches don't
		// come back truncated mid-array or wrapped in stray prose.
		...(opts.jsonMode && opts.schema
			? { responseSchema: opts.schema as GenerationConfig["responseSchema"] }
			: {}),
	} as GenerationConfig;

	let lastErr: unknown;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			const result = await genModel.generateContent({
				systemInstruction: systemMsg,
				contents: [{ role: "user", parts: [{ text: userMsg }] }],
				generationConfig,
			});

			const feedback = result.response.promptFeedback;
			if (feedback?.blockReason) {
				throw new Error(
					`Gemini blocked the prompt (${feedback.blockReason}) — try a less restrictive safety threshold or rephrase the context`,
				);
			}

			const candidate = result.response.candidates?.[0];
			const finishReason = candidate?.finishReason
				? String(candidate.finishReason)
				: undefined;
			if (
				finishReason &&
				finishReason !== "STOP" &&
				finishReason !== "MAX_TOKENS"
			) {
				throw new Error(
					`Gemini stopped generating unexpectedly (${finishReason})`,
				);
			}

			return result.response.text();
		} catch (err) {
			lastErr = err;
			const status = statusOf(err);
			const retryable =
				(status !== undefined && RETRYABLE_STATUS.has(status)) ||
				(err instanceof Error && /fetch failed|ECONNRESET|ETIMEDOUT/.test(err.message));
			if (!retryable || attempt === MAX_ATTEMPTS) throw err;
			const backoffMs = 500 * 2 ** (attempt - 1) + Math.random() * 250;
			await sleep(backoffMs);
		}
	}
	throw lastErr;
}
