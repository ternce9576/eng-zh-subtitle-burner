import { spawn } from "node:child_process";
import { join } from "node:path";
import { Progress } from "./progress.js";

/**
 * Runs whisper.py, turning its `__PROGRESS__ <done> <total>` markers into a
 * progress bar. Any other stderr output (model loading, CUDA info, warnings)
 * is passed through above the bar so nothing is hidden.
 */
export function transcribe(
	inputFile: string,
	srtOut: string,
	whisperModel: string,
	stage: string,
	hotwords = "",
): Promise<void> {
	const whisperScript = join(import.meta.dirname, "..", "..", "whisper.py");
	const progress = new Progress(stage, "Transcribing audio");

	return new Promise((resolve, reject) => {
		const child = spawn(
			"python3",
			[
				whisperScript,
				inputFile,
				srtOut,
				"--model",
				whisperModel,
				...(hotwords ? ["--hotwords", hotwords] : []),
			],
			{ stdio: ["ignore", "inherit", "pipe"] },
		);

		let buf = "";
		child.stderr.setEncoding("utf-8");
		child.stderr.on("data", (chunk: string) => {
			buf += chunk;
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			for (const line of lines) {
				const m = line.match(/^__PROGRESS__ ([\d.]+) ([\d.]+)$/);
				if (m) {
					const done = parseFloat(m[1]);
					const total = parseFloat(m[2]);
					if (total > 0) {
						progress.update(
							done / total,
							`${done.toFixed(0)}s / ${total.toFixed(0)}s of audio`,
						);
					}
				} else if (line.trim()) {
					progress.log(`    ${line.trimEnd()}`);
				}
			}
		});

		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				// VAD trims trailing silence, so the last segment's end can sit
				// short of the full duration. Snap to 100% rather than leaving
				// a finished stage reading 97%.
				progress.update(1);
				progress.done();
				resolve();
			} else {
				reject(new Error(`whisper.py exited with code ${code}`));
			}
		});
	});
}
