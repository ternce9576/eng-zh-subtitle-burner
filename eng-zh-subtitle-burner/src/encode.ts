import { execFileSync, spawn } from "node:child_process";
import { statSync } from "node:fs";
import { extname } from "node:path";
import { consola } from "consola";
import { Progress } from "./progress.js";
import { formatDuration, formatFileSize } from "./utils.js";

export interface EncodeOptions {
	crf: number;
	preset: string;
	/** Source audio codec, from ffprobe — decides copy vs re-encode for mp4. */
	audioCodec: string;
}

// Codecs MP4 can legally carry. Anything else (opus, vorbis, flac...) has to be
// re-encoded or the mux fails after the whole video pass has already run.
const MP4_SAFE_AUDIO = new Set(["aac", "mp3", "ac3", "eac3", "alac"]);

function audioArgs(outputFile: string, audioCodec: string): string[] {
	const ext = extname(outputFile).toLowerCase();
	if (ext === ".mp4" && !MP4_SAFE_AUDIO.has(audioCodec.toLowerCase())) {
		return ["-c:a", "aac", "-b:a", "192k"];
	}
	return ["-c:a", "copy"];
}

// MP4 keeps its index at the end of the file by default, so a player (or an
// upload form) has to fetch the whole thing before it can start. faststart
// moves it to the front.
function containerArgs(outputFile: string): string[] {
	return extname(outputFile).toLowerCase() === ".mp4"
		? ["-movflags", "+faststart"]
		: [];
}

// nvenc presets (p1-p7) are meaningless to libx264, so translate them when
// falling back to CPU. Anything else is passed through as-is.
const NVENC_TO_X264: Record<string, string> = {
	p1: "ultrafast",
	p2: "superfast",
	p3: "veryfast",
	p4: "medium",
	p5: "slow",
	p6: "slower",
	p7: "veryslow",
};

function x264Preset(preset: string): string {
	return NVENC_TO_X264[preset] ?? preset;
}

function getCodecArgs(
	outputFile: string,
	useNvenc: boolean,
	opts: EncodeOptions,
): string[] {
	const ext = extname(outputFile).toLowerCase();
	switch (ext) {
		case ".webm":
			return [
				"-c:v",
				"libvpx-vp9",
				"-crf",
				String(opts.crf),
				"-b:v",
				"0",
				"-c:a",
				"libopus",
			];
		case ".ogv":
			return ["-c:v", "libtheora", "-q:v", "7", "-c:a", "libvorbis"];
		default:
			if (useNvenc) {
				return [
					"-c:v",
					"h264_nvenc",
					"-preset",
					opts.preset,
					"-cq",
					String(opts.crf),
					"-b:v",
					"0",
					// Lookahead and adaptive quantisation are what let a higher
					// cq still look clean, so unlike the old p4/cq23 setup we
					// leave them on.
					"-rc-lookahead",
					"20",
					"-spatial-aq",
					"1",
					"-temporal-aq",
					"1",
					...audioArgs(outputFile, opts.audioCodec),
					...containerArgs(outputFile),
				];
			}
			return [
				"-c:v",
				"libx264",
				"-preset",
				x264Preset(opts.preset),
				"-crf",
				String(opts.crf),
				...audioArgs(outputFile, opts.audioCodec),
				...containerArgs(outputFile),
			];
	}
}

function escPath(p: string): string {
	return p
		.replace(/\\/g, "\\\\")
		.replace(/:/g, "\\:")
		.replace(/'/g, "\\'")
		.replace(/\[/g, "\\[")
		.replace(/\]/g, "\\]");
}

export function burnSubtitles(
	inputFile: string,
	assFile: string,
	outputFile: string,
	useNvenc: boolean,
	opts: EncodeOptions,
	durationSec: number,
	stage: string,
): Promise<void> {
	const codecArgs = getCodecArgs(outputFile, useNvenc, opts);
	const progress = new Progress(stage, "Burning subtitles");
	progress.log(
		`    ${codecArgs[1]} · crf=${opts.crf} · preset=${opts.preset}`,
	);

	return new Promise((resolve, reject) => {
		// `-progress pipe:1` emits machine-readable key=value blocks; `-nostats`
		// suppresses the usual carriage-return spam that otherwise buries every
		// other message in tens of thousands of lines.
		const child = spawn(
			"ffmpeg",
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-nostats",
				"-progress",
				"pipe:1",
				"-hwaccel",
				useNvenc ? "auto" : "none",
				"-i",
				inputFile,
				"-vf",
				`ass='${escPath(assFile)}'`,
				...codecArgs,
				"-threads",
				"0",
				"-filter_threads",
				"0",
				"-y",
				outputFile,
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);

		let outBuf = "";
		let fps = "";
		child.stdout.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => {
			outBuf += chunk;
			const lines = outBuf.split("\n");
			outBuf = lines.pop() ?? "";
			for (const line of lines) {
				const [key, value] = line.split("=");
				if (key === "fps") fps = value;
				if (key === "out_time_us" && durationSec > 0) {
					const seconds = parseInt(value, 10) / 1_000_000;
					progress.update(
						seconds / durationSec,
						`${formatDuration(seconds)} / ${formatDuration(durationSec)}${fps ? ` · ${fps}fps` : ""}`,
					);
				}
			}
		});

		let errBuf = "";
		child.stderr.setEncoding("utf-8");
		child.stderr.on("data", (chunk: string) => {
			errBuf += chunk;
			for (const line of chunk.split("\n")) {
				if (line.trim()) progress.log(`    ${line.trimEnd()}`);
			}
		});

		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) {
				reject(
					new Error(
						`ffmpeg exited with code ${code}${errBuf.trim() ? `: ${errBuf.trim().split("\n").slice(-3).join(" ")}` : ""}`,
					),
				);
				return;
			}
			progress.done(formatFileSize(statSync(outputFile).size));
			resolve();
		});
	});
}

export function muxSubtitles(
	inputFile: string,
	assFile: string,
	outputFile: string,
): void {
	consola.start("muxing subtitles (soft subs, no re-encode)...");
	const t0 = Date.now();

	execFileSync(
		"ffmpeg",
		[
			"-i",
			inputFile,
			"-i",
			assFile,
			"-map",
			"0",
			"-map",
			"1",
			"-c",
			"copy",
			"-c:s",
			"ass",
			"-y",
			outputFile,
		],
		{ stdio: "inherit" },
	);

	const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
	const outSize = formatFileSize(statSync(outputFile).size);
	consola.success(`muxing complete (${elapsed}s, ${outSize})`);
}
