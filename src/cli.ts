#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { defineCommand, runMain } from "citty";
import { consola } from "consola";
import { generateAss } from "./ass.js";
import { burnSubtitles, muxSubtitles } from "./encode.js";
import { checkNvenc, probeInput } from "./probe.js";
import { fixOverlaps, parseSrt, splitLongEntries } from "./srt.js";
import { transcribe } from "./transcribe.js";
import {
	type ApiProvider,
	checkOllamaGpu,
	DEFAULT_API_MODELS,
	fixTranscriptionSrt,
	translateSrt,
} from "./translate/index.js";
import { formatDuration, formatFileSize } from "./utils.js";

const main = defineCommand({
	meta: {
		name: "subtitle-burner",
		description: "Transcribe, translate, and embed EN/ZH subtitles into video",
	},
	args: {
		input: {
			type: "positional",
			description: "Input video file",
			required: true,
		},
		output: {
			type: "string",
			alias: "o",
			description: "Output file path",
		},
		"no-english": {
			type: "boolean",
			default: false,
			description: "Only show Chinese subtitles (omit English)",
		},
		soft: {
			type: "boolean",
			default: false,
			description: "Mux as soft subtitles (no re-encode, MKV output)",
		},
		crf: {
			type: "string",
			default: "23",
			description: "CRF quality for burn mode (lower = better)",
		},
		preset: {
			type: "string",
			default: "p4",
			description: "Encoder preset (nvenc: p1-p7, cpu: ultrafast-veryslow)",
		},
		"translate-via": {
			type: "string",
			default: "local",
			description: "local, chatgpt, gemini, or claude",
		},
		"ollama-url": {
			type: "string",
			default: "http://ollama:11434",
			description: "Ollama server URL",
		},
		model: {
			type: "string",
			default: "qwen3:14b",
			description:
				"Translation model name (local ollama or API model override)",
		},
		"api-key": {
			type: "string",
			description: "API key (required for chatgpt/gemini/claude)",
		},
		"fix-transcription": {
			type: "boolean",
			default: false,
			description:
				"Use AI to fix misheard words in transcription before translating",
		},
		context: {
			type: "string",
			description:
				'Additional context for AI (e.g. "youtuber plays minecraft hypixel bedwars")',
		},
		"batch-size": {
			type: "string",
			default: "20",
			description: "Translation batch size",
		},
		"whisper-model": {
			type: "string",
			default: "deepdml/faster-whisper-large-v3-turbo-ct2",
			description: "Whisper model name",
		},
		"en-font-size": {
			type: "string",
			default: "16",
			description: "English subtitle font size",
		},
		"zh-font-size": {
			type: "string",
			default: "18",
			description: "Chinese subtitle font size",
		},
		"margin-v-en": {
			type: "string",
			default: "12",
			description: "English subtitle bottom margin",
		},
		"margin-v-zh": {
			type: "string",
			default: "38",
			description: "Chinese subtitle bottom margin",
		},
	},
	async run({ args }) {
		const pipelineT0 = Date.now();

		const input = resolve(args.input);
		const noEnglish = args["no-english"];
		const soft = args.soft;
		const crfVal = parseInt(args.crf, 10);
		const preset = args.preset;
		const translateVia = args["translate-via"] as "local" | ApiProvider;
		const isApi = translateVia !== "local";
		const ollamaUrl = args["ollama-url"];
		const modelName = args.model;
		const apiKey = args["api-key"];
		const fixTranscription = args["fix-transcription"];
		const context = args.context;
		const batchSize = parseInt(args["batch-size"], 10);
		const whisperModel = args["whisper-model"];
		const enFontSize = parseInt(args["en-font-size"], 10);
		const zhFontSize = parseInt(args["zh-font-size"], 10);
		const marginVEn = parseInt(args["margin-v-en"], 10);
		const marginVZh = parseInt(args["margin-v-zh"], 10);

		if (isApi) {
			if (!["claude", "chatgpt", "gemini"].includes(translateVia)) {
				consola.error(
					"--translate-via must be one of: local, chatgpt, gemini, claude",
				);
				process.exit(1);
			}
			if (!apiKey) {
				consola.error(
					`--api-key is required when using --translate-via ${translateVia}`,
				);
				process.exit(1);
			}
		}

		const defaultExt = soft ? ".mkv" : extname(input) || ".mp4";
		const output = resolve(
			args.output ?? `${input.replace(/\.[^.]+$/, "")}_subtitled${defaultExt}`,
		);

		consola.box("eng-zh-subtitle-burner");

		const probe = probeInput(input);
		consola.info(`input: ${basename(input)}`);
		consola.info(
			`  format: ${probe.format} | ${probe.resolution} | ${probe.fps}fps`,
		);
		consola.info(
			`  codecs: video=${probe.videoCodec} audio=${probe.audioCodec}`,
		);
		consola.info(
			`  duration: ${formatDuration(probe.duration)} | size: ${formatFileSize(probe.fileSize)}`,
		);
		consola.info(
			`output: ${basename(output)} (${soft ? "soft subs" : `burn, crf=${crfVal}`})`,
		);
		if (noEnglish) {
			consola.info("mode: chinese only (--no-english)");
		}
		if (isApi) {
			const apiModel =
				modelName !== "qwen3:14b"
					? modelName
					: DEFAULT_API_MODELS[translateVia as ApiProvider];
			consola.info(`translation: ${translateVia} API (${apiModel})`);
		} else {
			consola.info(`translation: local ollama (${modelName})`);
		}

		const useNvenc = !soft && checkNvenc();
		if (!soft) {
			if (useNvenc) {
				consola.success("nvenc available — using GPU encoding");
			} else {
				consola.warn("nvenc not available — falling back to CPU encoding");
			}
		}

		if (
			soft &&
			![".mkv", ".mka", ".webm"].includes(extname(output).toLowerCase())
		) {
			consola.warn(
				`soft subs work best with MKV container; ${extname(output)} may not support ASS styling`,
			);
		}

		const tmp = mkdtempSync(join(tmpdir(), "subpipe-"));

		try {
			const enSrt = join(tmp, "en.srt");
			const zhSrt = join(tmp, "zh.srt");
			const assFile = join(tmp, "subtitles.ass");

			const translateCfg: import("./translate/index.js").TranslateConfig = {
				via: isApi ? "api" : "local",
				ollamaUrl,
				localModel: modelName,
				provider: isApi ? (translateVia as ApiProvider) : undefined,
				apiKey,
				apiModel: isApi && modelName !== "qwen3:14b" ? modelName : undefined,
				batchSize,
			};

			if (!isApi) {
				await checkOllamaGpu(ollamaUrl, modelName);
			}
			transcribe(input, enSrt, whisperModel);
			if (fixTranscription) {
				await fixTranscriptionSrt(enSrt, translateCfg, context);
			}
			await translateSrt(enSrt, zhSrt, translateCfg, context);

			const enRaw = fixOverlaps(parseSrt(readFileSync(enSrt, "utf-8")));
			const zhRaw = fixOverlaps(parseSrt(readFileSync(zhSrt, "utf-8")));
			const { en: enEntries, zh: zhEntries } = splitLongEntries(
				enRaw,
				zhRaw,
				16,
			);
			consola.info(
				`subtitle entries: ${enEntries.length} EN, ${zhEntries.length} ZH (split from ${enRaw.length} segments)`,
			);

			writeFileSync(
				assFile,
				generateAss(enEntries, zhEntries, {
					noEnglish,
					enFontSize,
					zhFontSize,
					marginVEn,
					marginVZh,
				}),
				"utf-8",
			);

			if (soft) {
				muxSubtitles(input, assFile, output);
			} else {
				burnSubtitles(input, assFile, output, useNvenc, {
					crf: crfVal,
					preset,
				});
			}

			const totalElapsed = ((Date.now() - pipelineT0) / 1000).toFixed(1);
			consola.success(`done in ${totalElapsed}s! output: ${output}`);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	},
});

runMain(main);
