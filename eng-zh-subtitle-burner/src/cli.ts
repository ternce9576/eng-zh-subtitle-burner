#!/usr/bin/env node
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { defineCommand, runMain } from "citty";
import { consola } from "consola";
import { generateAss } from "./ass.js";
import { burnSubtitles, muxSubtitles } from "./encode.js";
import { checkNvenc, probeInput } from "./probe.js";
import { loadGlossary } from "./glossary.js";
import { fixOverlaps, parseSrt, splitLongEntries } from "./srt.js";
import { transcribe } from "./transcribe.js";
import { UNTRANSLATED } from "./translate/common.js";
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
		// NOTE: must NOT be named "no-english" — citty parses a `--no-x` flag as
		// negating `x`, so `--no-english` silently resolved to false and the
		// option never worked. `--no-english` is still accepted below via a
		// direct argv check for backwards compatibility.
		"chinese-only": {
			type: "boolean",
			default: false,
			description: "Only burn Chinese subtitles (omit English)",
		},
		soft: {
			type: "boolean",
			default: false,
			description: "Mux as soft subtitles (no re-encode, MKV output)",
		},
		crf: {
			type: "string",
			default: "28",
			description: "CRF/CQ quality for burn mode (lower = better, bigger)",
		},
		preset: {
			type: "string",
			default: "p6",
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
			description:
				"API key (falls back to GEMINI_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY)",
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
		concurrency: {
			type: "string",
			default: "4",
			description: "Batches sent in parallel (1 = fully sequential)",
		},
		glossary: {
			type: "string",
			description:
				"Creator term list (English => 中文, one per line). Biases transcription and pins translations.",
		},
		"ass-out": {
			type: "string",
			description:
				"Where to write the generated .ass (default: beside the output video)",
		},
		"whisper-model": {
			type: "string",
			default: "deepdml/faster-whisper-large-v3-turbo-ct2",
			description: "Whisper model name",
		},
		"en-font": {
			type: "string",
			default: "Poppins ExtraBold",
			description: "English subtitle font family",
		},
		"zh-font": {
			type: "string",
			default: "Smiley Sans",
			description: "Chinese subtitle font family",
		},
		outline: {
			type: "string",
			default: "2.5",
			description: "Subtitle outline thickness",
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
		const noEnglish =
			args["chinese-only"] || process.argv.includes("--no-english");
		const soft = args.soft;
		const crfVal = parseInt(args.crf, 10);
		const preset = args.preset;
		const translateVia = args["translate-via"] as "local" | ApiProvider;
		const isApi = translateVia !== "local";
		const ollamaUrl = args["ollama-url"];
		const modelName = args.model;
		// Prefer the environment over --api-key: a key passed as an argument is
		// visible to anyone who can run `ps` or `docker inspect`, and lands in
		// shell history. The flag still works for one-off overrides.
		const ENV_KEY_FOR: Record<ApiProvider, string> = {
			claude: "ANTHROPIC_API_KEY",
			chatgpt: "OPENAI_API_KEY",
			gemini: "GEMINI_API_KEY",
		};
		const envVar =
			translateVia !== "local" ? ENV_KEY_FOR[translateVia as ApiProvider] : undefined;
		const apiKey = args["api-key"] ?? (envVar ? process.env[envVar] : undefined);
		const fixTranscription = args["fix-transcription"];
		const glossary = loadGlossary(args.glossary);
		// Glossary terms ride along with the channel context: the translator sees
		// them as hard rules, whisper sees the English side as hotwords.
		const context = [args.context, glossary.promptBlock]
			.filter(Boolean)
			.join("\n\n");
		const batchSize = parseInt(args["batch-size"], 10);
		const concurrency = Math.max(1, parseInt(args.concurrency, 10) || 1);
		const whisperModel = args["whisper-model"];
		const assOut = args["ass-out"];
		const enFont = args["en-font"];
		const zhFont = args["zh-font"];
		const outline = parseFloat(args.outline);
		const enFontSize = parseInt(args["en-font-size"], 10);
		const zhFontSize = parseInt(args["zh-font-size"], 10);
		const marginVEn = parseInt(args["margin-v-en"], 10);
		// With both languages the Chinese line sits above the English one. With
		// --chinese-only it drops into the English line's slot at the bottom of
		// the frame -- unless a margin is given explicitly, which is how a creator
		// who burns their own captions mid-frame gets ours placed above theirs.
		const marginVZhSet = process.argv.some(
			(a) => a === "--margin-v-zh" || a.startsWith("--margin-v-zh="),
		);
		const marginVZh =
			!noEnglish || marginVZhSet ? parseInt(args["margin-v-zh"], 10) : marginVEn;

		if (isApi) {
			if (!["claude", "chatgpt", "gemini"].includes(translateVia)) {
				consola.error(
					"--translate-via must be one of: local, chatgpt, gemini, claude",
				);
				process.exit(1);
			}
			if (!apiKey) {
				consola.error(
					`no API key for ${translateVia} — set ${envVar} or pass --api-key`,
				);
				process.exit(1);
			}
		}

		// Burned output defaults to MP4 — Bilibili won't accept MKV. Soft subs
		// still have to be MKV because MP4 can't carry an ASS track.
		const defaultExt = soft ? ".mkv" : ".mp4";
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
			consola.info("mode: chinese only");
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
				concurrency,
			};

			if (!isApi) {
				await checkOllamaGpu(ollamaUrl, modelName);
			}
			// Stage numbering is computed up front so the labels read
			// "[2/4]" or "[2/3]" depending on whether --fix-transcription
			// adds its pass.
			const totalStages = fixTranscription ? 4 : 3;
			let stageNum = 0;
			const nextStage = () => `${++stageNum}/${totalStages}`;

			await transcribe(
				input,
				enSrt,
				whisperModel,
				nextStage(),
				glossary.hotwords,
			);
			if (fixTranscription) {
				await fixTranscriptionSrt(
					enSrt,
					translateCfg,
					context,
					nextStage(),
				);
			}
			const translateResult = await translateSrt(
				enSrt,
				zhSrt,
				translateCfg,
				context,
				nextStage(),
			);

			const enRaw = fixOverlaps(parseSrt(readFileSync(enSrt, "utf-8")));
			const zhRaw = fixOverlaps(parseSrt(readFileSync(zhSrt, "utf-8")));
			// Bilibili gaming subtitles cut fast — one short clause per card.
			// A high threshold here lets whole sentences ride on a single
			// subtitle, which flattens the punchy register the prompt asks for.
			const { en: enEntries, zh: zhEntries } = splitLongEntries(
				enRaw,
				zhRaw,
				9,
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
					enFont,
					zhFont,
					outline,
				}),
				"utf-8",
			);

			// Keep the ASS next to the finished video. It's the only durable
			// record of what was actually rendered — the temp dir is deleted on
			// exit, and burned-in subtitles can't be read back out of the file.
			const assCopy = assOut
				? resolve(assOut)
				: `${output.replace(/\.[^.]+$/, "")}.ass`;
			mkdirSync(dirname(assCopy), { recursive: true });
			copyFileSync(assFile, assCopy);
			consola.info(`subtitles: ${assCopy}`);

			const srtBase = assCopy.replace(/\.ass$/i, "");

			if (soft) {
				muxSubtitles(input, assFile, output);
			} else {
				await burnSubtitles(
					input,
					assFile,
					output,
					useNvenc,
					{ crf: crfVal, preset, audioCodec: probe.audioCodec },
					probe.duration,
					nextStage(),
				);
			}

			const totalElapsed = ((Date.now() - pipelineT0) / 1000).toFixed(1);
			consola.success(`done in ${totalElapsed}s! output: ${output}`);

			// Loud, last-thing-on-screen report. The per-batch warnings scroll
			// away behind thousands of ffmpeg progress lines, so anything that
			// needs attention gets repeated here after the encode.
			if (translateResult.untranslated.length > 0) {
				const n = translateResult.untranslated.length;
				// Only written when something went wrong -- these exist so the
				// failed lines can be fixed and remuxed, not as a routine artifact.
				const enCopy = `${srtBase}.en.srt`;
				const zhCopy = `${srtBase}.zh.srt`;
				copyFileSync(enSrt, enCopy);
				copyFileSync(zhSrt, zhCopy);

				const shown = translateResult.untranslated.slice(0, 25).join(", ");
				const more = n > 25 ? ` (+${n - 25} more)` : "";
				consola.box(
					[
						`⚠  PIPELINE NEEDS ATTENTION`,
						``,
						`${n} of ${translateResult.total} subtitles failed to translate and were`,
						`left BLANK in the video — those moments have no Chinese subtitle.`,
						``,
						`Subtitle numbers: ${shown}${more}`,
						``,
						`Sidecar files written (search for "${UNTRANSLATED}"):`,
						`  ${zhCopy}`,
						`  ${enCopy}`,
						``,
						`Fix those lines, then re-run with --soft to remux quickly,`,
						`or lower --batch-size and translate again.`,
					].join("\n"),
				);
			}
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	},
});

runMain(main);
