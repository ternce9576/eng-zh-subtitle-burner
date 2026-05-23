import { readFileSync, writeFileSync } from "node:fs";
import { consola } from "consola";
import { type SrtEntry, formatSrt, parseSrt } from "../srt.js";
import { chatChatgpt } from "./chatgpt.js";
import { chatClaude } from "./claude.js";
import {
	type ChatOptions,
	type RecentPair,
	buildFixPrompt,
	buildFixSystem,
	buildTranslatePrompt,
	buildTranslateSystem,
	parseFixResponse,
	parseTranslateResponse,
} from "./common.js";
import { chatGemini } from "./gemini.js";
import { chatLocal } from "./local.js";

export type ApiProvider = "claude" | "chatgpt" | "gemini";

export const DEFAULT_API_MODELS: Record<ApiProvider, string> = {
	claude: "claude-sonnet-4-5",
	chatgpt: "gpt-4o",
	gemini: "gemini-2.0-flash",
};

export interface TranslateConfig {
	via: "local" | "api";
	ollamaUrl: string;
	localModel: string;
	provider?: ApiProvider;
	apiKey?: string;
	apiModel?: string;
	batchSize: number;
}

type ChatFn = (
	system: string,
	user: string,
	opts?: ChatOptions,
) => Promise<string>;

const RECENT_WINDOW = 6;

function getChatFn(cfg: TranslateConfig): ChatFn {
	if (cfg.via === "api") {
		const model = cfg.apiModel ?? DEFAULT_API_MODELS[cfg.provider!];
		switch (cfg.provider!) {
			case "claude":
				return (sys, usr, opts) =>
					chatClaude(sys, usr, cfg.apiKey!, model, opts);
			case "chatgpt":
				return (sys, usr, opts) =>
					chatChatgpt(sys, usr, cfg.apiKey!, model, opts);
			case "gemini":
				return (sys, usr, opts) =>
					chatGemini(sys, usr, cfg.apiKey!, model, opts);
		}
	}
	return (sys, usr, opts) =>
		chatLocal(sys, usr, cfg.ollamaUrl, cfg.localModel, opts);
}

function describeTranslation(cfg: TranslateConfig): string {
	if (cfg.via === "api") {
		const model = cfg.apiModel ?? DEFAULT_API_MODELS[cfg.provider!];
		return `${cfg.provider} API (${model})`;
	}
	return `ollama (${cfg.localModel})`;
}

export async function fixTranscriptionSrt(
	enSrtPath: string,
	cfg: TranslateConfig,
	context?: string,
): Promise<void> {
	const entries = parseSrt(readFileSync(enSrtPath, "utf-8"));
	const totalBatches = Math.ceil(entries.length / cfg.batchSize);
	const via = describeTranslation(cfg);
	consola.start(
		`fixing transcription for ${entries.length} entries via ${via}, ${totalBatches} batches`,
	);
	if (context) consola.info(`  context: "${context}"`);

	const t0 = Date.now();
	const chat = getChatFn(cfg);
	const systemMsg = buildFixSystem(context);
	const fixedEntries: SrtEntry[] = [];
	let totalMissing = 0;

	for (let i = 0; i < entries.length; i += cfg.batchSize) {
		const batchNum = Math.floor(i / cfg.batchSize) + 1;
		const batch = entries.slice(i, i + cfg.batchSize);
		const texts = batch.map((e) => e.text);
		consola.info(
			`  batch ${batchNum}/${totalBatches} (${texts.length} lines)...`,
		);
		const batchT0 = Date.now();

		let parsedRes = parseFixResponse(
			await chat(systemMsg, buildFixPrompt(texts), {
				jsonMode: true,
				temperature: 0.2,
			}),
			texts.length,
		);
		if (parsedRes.parsed === 0) {
			consola.warn(`  batch ${batchNum} returned no parseable lines — retrying`);
			parsedRes = parseFixResponse(
				await chat(systemMsg, buildFixPrompt(texts), {
					jsonMode: true,
					temperature: 0.2,
				}),
				texts.length,
			);
		}

		const batchElapsed = ((Date.now() - batchT0) / 1000).toFixed(1);
		for (let j = 0; j < batch.length; j++) {
			fixedEntries.push({
				index: batch[j].index,
				time: batch[j].time,
				text: parsedRes.result[j] || batch[j].text,
			});
		}
		if (parsedRes.missing.length > 0) {
			totalMissing += parsedRes.missing.length;
			consola.warn(
				`  batch ${batchNum}: ${parsedRes.missing.length}/${texts.length} lines unparsed (kept original)`,
			);
		}
		const done = Math.min(i + cfg.batchSize, entries.length);
		consola.success(
			`  batch ${batchNum} done: ${done}/${entries.length} (${batchElapsed}s)`,
		);
	}

	const totalElapsed = ((Date.now() - t0) / 1000).toFixed(1);
	if (totalMissing > 0) {
		consola.warn(
			`transcription fix complete (${totalElapsed}s) — ${totalMissing} lines kept original due to parse failure`,
		);
	} else {
		consola.success(`transcription fix complete (${totalElapsed}s)`);
	}
	writeFileSync(enSrtPath, formatSrt(fixedEntries), "utf-8");
}

export async function translateSrt(
	enSrtPath: string,
	zhSrtPath: string,
	cfg: TranslateConfig,
	context?: string,
): Promise<void> {
	const entries = parseSrt(readFileSync(enSrtPath, "utf-8"));
	const totalBatches = Math.ceil(entries.length / cfg.batchSize);
	const via = describeTranslation(cfg);
	consola.start(
		`translating ${entries.length} entries to chinese via ${via}, ${totalBatches} batches`,
	);
	if (context) consola.info(`  context: "${context}"`);

	const t0 = Date.now();
	const zhEntries: SrtEntry[] = [];
	const chat = getChatFn(cfg);
	const systemMsg = buildTranslateSystem(context);
	const recent: RecentPair[] = [];
	let totalMissing = 0;

	for (let i = 0; i < entries.length; i += cfg.batchSize) {
		const batchNum = Math.floor(i / cfg.batchSize) + 1;
		const batch = entries.slice(i, i + cfg.batchSize);
		const texts = batch.map((e) => e.text);
		consola.info(
			`  batch ${batchNum}/${totalBatches} (${texts.length} lines)...`,
		);
		const batchT0 = Date.now();

		let parsedRes = parseTranslateResponse(
			await chat(systemMsg, buildTranslatePrompt(texts, recent), {
				jsonMode: true,
				temperature: 0.5,
			}),
			texts.length,
		);
		if (parsedRes.parsed === 0) {
			consola.warn(`  batch ${batchNum} returned no parseable lines — retrying`);
			parsedRes = parseTranslateResponse(
				await chat(systemMsg, buildTranslatePrompt(texts, recent), {
					jsonMode: true,
					temperature: 0.5,
				}),
				texts.length,
			);
		}

		const batchElapsed = ((Date.now() - batchT0) / 1000).toFixed(1);
		for (let j = 0; j < batch.length; j++) {
			const zh = parsedRes.result[j];
			zhEntries.push({
				index: batch[j].index,
				time: batch[j].time,
				text: zh || batch[j].text,
			});
			if (zh) recent.push({ en: batch[j].text, zh });
		}
		while (recent.length > RECENT_WINDOW) recent.shift();

		if (parsedRes.missing.length > 0) {
			totalMissing += parsedRes.missing.length;
			consola.warn(
				`  batch ${batchNum}: ${parsedRes.missing.length}/${texts.length} lines unparsed (kept original english)`,
			);
		}
		const done = Math.min(i + cfg.batchSize, entries.length);
		consola.success(
			`  batch ${batchNum} done: ${done}/${entries.length} (${batchElapsed}s)`,
		);
	}

	const totalElapsed = ((Date.now() - t0) / 1000).toFixed(1);
	if (totalMissing > 0) {
		consola.warn(
			`translation complete (${totalElapsed}s) — ${totalMissing} lines kept original english due to parse failure`,
		);
	} else {
		consola.success(`translation complete (${totalElapsed}s)`);
	}
	writeFileSync(zhSrtPath, formatSrt(zhEntries), "utf-8");
}

export async function checkOllamaGpu(
	ollamaUrl: string,
	model: string,
): Promise<void> {
	try {
		const res = await fetch(`${ollamaUrl}/api/ps`);
		if (res.ok) {
			const data = (await res.json()) as {
				models?: { name: string; size: number }[];
			};
			consola.info(`ollama server reachable at ${ollamaUrl}`);
			if (data.models?.length) {
				for (const m of data.models) {
					consola.info(
						`loaded model: ${m.name} (${(m.size / 1e9).toFixed(1)} GB)`,
					);
				}
			} else {
				consola.info(
					`no models loaded yet (first request will load ${model})`,
				);
			}
		}
	} catch (err) {
		consola.warn(`cannot reach ollama at ${ollamaUrl}: ${err}`);
	}
}
