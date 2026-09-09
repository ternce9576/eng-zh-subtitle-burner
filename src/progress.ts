/**
 * Single-line progress bar for the pipeline's long-running stages.
 *
 * Everything renders to stderr so piping stdout stays clean. When stderr isn't
 * a TTY (CI, `> log.txt`, docker without -t) the carriage-return redraw would
 * produce thousands of junk lines, so we fall back to printing a milestone
 * line every 10% instead.
 */

const BAR_WIDTH = 24;
const isTty = Boolean(process.stderr.isTTY);

function formatEta(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export class Progress {
	private readonly t0 = Date.now();
	private lastRenderedPct = -1;
	private lastMilestone = -1;
	private finished = false;

	/**
	 * @param stage   e.g. "3/4"
	 * @param label   e.g. "Translating to Chinese"
	 */
	constructor(
		private readonly stage: string,
		private readonly label: string,
	) {
		if (isTty) process.stderr.write(`\n`);
		else process.stderr.write(`\n[${stage}] ${label}...\n`);
	}

	/** @param fraction 0..1 */
	update(fraction: number, note = ""): void {
		if (this.finished) return;
		const clamped = Math.max(0, Math.min(1, fraction));
		const pct = Math.floor(clamped * 100);
		const elapsed = (Date.now() - this.t0) / 1000;
		const eta = clamped > 0.02 ? elapsed / clamped - elapsed : Number.NaN;

		if (!isTty) {
			// Only speak up every 10% so a redirected log stays readable.
			const milestone = Math.floor(pct / 10);
			if (milestone > this.lastMilestone) {
				this.lastMilestone = milestone;
				process.stderr.write(
					`  [${this.stage}] ${this.label}: ${pct}%${note ? ` — ${note}` : ""} (eta ${formatEta(eta)})\n`,
				);
			}
			return;
		}

		if (pct === this.lastRenderedPct && !note) return;
		this.lastRenderedPct = pct;

		const filled = Math.round(clamped * BAR_WIDTH);
		const bar = "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
		const line = `  [${this.stage}] ${this.label} ▕${bar}▏ ${String(pct).padStart(3)}%  ${note}  eta ${formatEta(eta)}`;
		process.stderr.write(`\r\x1b[2K${line}`);
	}

	/** Print a message without the bar eating it. */
	log(message: string): void {
		if (isTty) process.stderr.write(`\r\x1b[2K`);
		process.stderr.write(`${message}\n`);
		this.lastRenderedPct = -1;
	}

	done(note = ""): void {
		if (this.finished) return;
		this.finished = true;
		const elapsed = ((Date.now() - this.t0) / 1000).toFixed(1);
		if (isTty) process.stderr.write(`\r\x1b[2K`);
		process.stderr.write(
			`  ✔ [${this.stage}] ${this.label} — ${elapsed}s${note ? ` (${note})` : ""}\n`,
		);
	}
}
