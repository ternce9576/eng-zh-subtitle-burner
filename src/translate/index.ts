import { readFileSync, writeFileSync } from "node:fs";
import { consola } from "consola";
import { Progress } from "../progress.js";
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
	fixResponseSchema,
	parseFixResponse,
	parseTranslateResponse,
	translateResponseSchema,
	UNTRANSLATED,
} from "./common.js";
import { chatGemini } from "./gemini.js";
import { chatLocal } from "./local.js";

export type ApiProvider = "claude" | "chatgpt" | "gemini";

export const DEFAULT_API_MODELS: Record<ApiProvider, string> = {
	claude: "claude-sonnet-5",
	chatgpt: "gpt-4.1",
	gemini: "gemini-3.1-pro-preview",
};

export interface TranslateConfig {
	via: "local" | "api";
	ollamaUrl: string;
	localModel: string;
	provider?: ApiProvider;
	apiKey?: string;
	apiModel?: string;
	batchSize: number;
	/** Batches sent concurrently. See the wave note on runInWaves(). */
	concurrency: number;
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

interface Batch {
	num: number;
	entries: SrtEntry[];
}

function toBatches(entries: SrtEntry[], size: number): Batch[] {
	const batches: Batch[] = [];
	for (let i = 0; i < entries.length; i += size) {
		batches.push({
			num: batches.length + 1,
			entries: entries.slice(i, i + size),
		});
	}
	return batches;
}

/**
 * Run batches `concurrency` at a time.
 *
 * Translation needs the previously translated lines for tone/terminology
 * continuity, which is inherently sequential — so instead of a free-for-all we
 * go in waves: every batch in a wave sees the same continuity snapshot taken
 * when the wave started, and the snapshot is only extended once the whole wave
 * lands. Continuity is slightly looser inside a wave than it was sequentially,
 * but it still carries across the file, and the API stages (~89% of runtime)
 * drop by roughly the concurrency factor.
 */
async function runInWaves<T>(
	batches: Batch[],
	concurrency: number,
	run: (batch: Batch, waveIndex: number) => Promise<T>,
	onWaveDone: (waveResults: { batch: Batch; result: T }[]) => void,
): Promise<void> {
	for (let i = 0; i < batches.length; i += concurrency) {
		const wave = batches.slice(i, i + concurrency);
		const settled = await Promise.all(
			wave.map(async (batch) => ({
				batch,
				result: await run(batch, i),
			})),
		);
		onWaveDone(settled);
	}
}

export async function fixTranscriptionSrt(
	enSrtPath: string,
	cfg: TranslateConfig,
	context: string | undefined,
	stage: string,
): Promise<void> {
	const entries = parseSrt(readFileSync(enSrtPath, "utf-8"));
	const batches = toBatches(entries, cfg.batchSize);
	const via = describeTranslation(cfg);
	const progress = new Progress(stage, "Fixing transcription");
	progress.log(
		`    ${entries.length} lines · ${batches.length} batches · ${cfg.concurrency} at a time · ${via}`,
	);
	if (context) progress.log(`    context: "${context}"`);

	const chat = getChatFn(cfg);
	const systemMsg = buildFixSystem(context);
	const fixed = new Map<number, string[]>();
	let totalMissing = 0;
	let linesDone = 0;

	// The fix pass has no cross-batch dependency at all — each line is proofread
	// in isolation — so it parallelizes cleanly.
	await runInWaves(
		batches,
		cfg.concurrency,
		async (batch) => {
			const texts = batch.entries.map((e) => e.text);
			const ask = () =>
				chat(systemMsg, buildFixPrompt(texts), {
					jsonMode: true,
					temperature: 0.2,
					schema: fixResponseSchema(),
				});

			let res = parseFixResponse(await ask(), texts.length);
			if (res.parsed === 0) {
				progress.log(
					`    ⚠ batch ${batch.num} returned no parseable lines — retrying`,
				);
				res = parseFixResponse(await ask(), texts.length);
			}
			return res;
		},
		(waveResults) => {
			for (const { batch, result } of waveResults) {
				fixed.set(
					batch.num,
					batch.entries.map((e, j) => result.result[j] || e.text),
				);
				if (result.missing.length > 0) {
					totalMissing += result.missing.length;
					progress.log(
						`    ⚠ batch ${batch.num}: ${result.missing.length}/${batch.entries.length} lines unparsed (kept original)`,
					);
				}
				linesDone += batch.entries.length;
			}
			progress.update(
				linesDone / entries.length,
				`${linesDone}/${entries.length} lines`,
			);
		},
	);

	const fixedEntries: SrtEntry[] = [];
	for (const batch of batches) {
		const texts = fixed.get(batch.num) ?? batch.entries.map((e) => e.text);
		batch.entries.forEach((e, j) => {
			fixedEntries.push({ index: e.index, time: e.time, text: texts[j] });
		});
	}

	progress.done(
		totalMissing > 0 ? `${totalMissing} lines kept original` : undefined,
	);
	writeFileSync(enSrtPath, formatSrt(fixedEntries), "utf-8");
}

export interface TranslateResult {
	/** 1-based subtitle numbers the model never returned a translation for. */
	untranslated: number[];
	total: number;
}

export async function translateSrt(
	enSrtPath: string,
	zhSrtPath: string,
	cfg: TranslateConfig,
	context: string | undefined,
	stage: string,
): Promise<TranslateResult> {
	const entries = parseSrt(readFileSync(enSrtPath, "utf-8"));
	const batches = toBatches(entries, cfg.batchSize);
	const via = describeTranslation(cfg);
	const progress = new Progress(stage, "Translating to Chinese");
	progress.log(
		`    ${entries.length} lines · ${batches.length} batches · ${cfg.concurrency} at a time · ${via}`,
	);
	if (context) progress.log(`    context: "${context}"`);

	const chat = getChatFn(cfg);
	const systemMsg = buildTranslateSystem(context);
	const recent: RecentPair[] = [];
	const translated = new Map<number, string[]>();
	let totalMissing = 0;
	let linesDone = 0;

	await runInWaves(
		batches,
		cfg.concurrency,
		async (batch) => {
			const texts = batch.entries.map((e) => e.text);
			// Snapshot taken here, so every batch in this wave shares the same
			// continuity context.
			const continuity = [...recent];
			const ask = () =>
				chat(systemMsg, buildTranslatePrompt(texts, continuity), {
					jsonMode: true,
					temperature: 0.7,
					schema: translateResponseSchema(),
				});

			let res = parseTranslateResponse(await ask(), texts.length);
			if (res.parsed === 0) {
				progress.log(
					`    ⚠ batch ${batch.num} returned no parseable lines — retrying`,
				);
				res = parseTranslateResponse(await ask(), texts.length);
			}
			return res;
		},
		(waveResults) => {
			for (const { batch, result } of waveResults) {
				translated.set(batch.num, result.result);
				for (let j = 0; j < batch.entries.length; j++) {
					const zh = result.result[j];
					if (zh) recent.push({ en: batch.entries[j].text, zh });
				}
				if (result.missing.length > 0) {
					totalMissing += result.missing.length;
					progress.log(
						`    ⚠ batch ${batch.num}: ${result.missing.length}/${batch.entries.length} lines unparsed (left blank)`,
					);
				}
				linesDone += batch.entries.length;
			}
			while (recent.length > RECENT_WINDOW) recent.shift();
			progress.update(
				linesDone / entries.length,
				`${linesDone}/${entries.length} lines`,
			);
		},
	);

	const zhEntries: SrtEntry[] = [];
	const untranslated: number[] = [];
	for (const batch of batches) {
		const texts = translated.get(batch.num) ?? [];
		batch.entries.forEach((e, j) => {
			const zh = texts[j];
			// A failed line gets the placeholder, never the English source —
			// burning English into the Chinese track is a silent corruption
			// that looks like a successful run.
			zhEntries.push({ index: e.index, time: e.time, text: zh || UNTRANSLATED });
			if (!zh) untranslated.push(e.index);
		});
	}

	progress.done(totalMissing > 0 ? `${totalMissing} lines left blank` : undefined);
	writeFileSync(zhSrtPath, formatSrt(zhEntries), "utf-8");
	return { untranslated, total: entries.length };
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
