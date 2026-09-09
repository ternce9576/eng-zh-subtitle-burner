import { execFileSync } from "node:child_process";
import { consola } from "consola";

export interface ProbeResult {
	format: string;
	duration: number;
	fileSize: number;
	videoCodec: string;
	audioCodec: string;
	resolution: string;
	fps: number;
}

export function probeInput(inputFile: string): ProbeResult {
	const raw = execFileSync(
		"ffprobe",
		[
			"-v",
			"quiet",
			"-print_format",
			"json",
			"-show_format",
			"-show_streams",
			inputFile,
		],
		{ encoding: "utf-8" },
	);

	const info = JSON.parse(raw) as {
		format: { format_name: string; duration: string; size: string };
		streams: {
			codec_type: string;
			codec_name: string;
			width?: number;
			height?: number;
			r_frame_rate?: string;
		}[];
	};

	const video = info.streams.find((s) => s.codec_type === "video");
	const audio = info.streams.find((s) => s.codec_type === "audio");

	let fps = 0;
	if (video?.r_frame_rate) {
		const [num, den] = video.r_frame_rate.split("/").map(Number);
		if (den) fps = Math.round((num / den) * 100) / 100;
	}

	return {
		format: info.format.format_name,
		duration: parseFloat(info.format.duration),
		fileSize: parseInt(info.format.size, 10),
		videoCodec: video?.codec_name ?? "unknown",
		audioCodec: audio?.codec_name ?? "none",
		resolution: video ? `${video.width}x${video.height}` : "unknown",
		fps,
	};
}

export function checkNvenc(): boolean {
	try {
		const result = execFileSync("ffmpeg", ["-hide_banner", "-encoders"], {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		if (!result.includes("h264_nvenc")) return false;
	} catch {
		return false;
	}

	// Being compiled in doesn't mean it runs — the driver may be older than the
	// nvenc API ffmpeg was built against. Actually encode a frame to find out.
	// This is a hard failure: a machine with an NVENC-capable GPU should never
	// silently drop to CPU encoding, it should be fixed.
	try {
		execFileSync(
			"ffmpeg",
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-f",
				"lavfi",
				"-i",
				// nvenc rejects frames below its minimum dimensions, so keep this
				// comfortably above them or the probe false-negatives.
				"nullsrc=s=256x256:d=0.1",
				"-c:v",
				"h264_nvenc",
				"-frames:v",
				"1",
				"-f",
				"null",
				"-",
			],
			{ encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
		);
		return true;
	} catch (err) {
		const stderr = (err as { stderr?: string }).stderr ?? "";
		consola.error("h264_nvenc is present but cannot encode:");
		if (stderr.trim()) consola.error(stderr.trim());
		consola.error(
			"this is usually an NVIDIA driver older than the nvenc API ffmpeg was built against — update your driver, or pin an older ffmpeg build in the Dockerfile",
		);
		process.exit(1);
	}
}
