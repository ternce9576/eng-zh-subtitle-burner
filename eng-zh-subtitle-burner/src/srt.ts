export interface SrtEntry {
	index: number;
	time: string;
	text: string;
}

export function srtTimeToSeconds(time: string): number {
	const [hms, ms] = time.split(",");
	const [h, m, s] = hms.split(":").map(Number);
	return h * 3600 + m * 60 + s + parseInt(ms, 10) / 1000;
}

export function secondsToSrtTime(totalSec: number): string {
	const totalMs = Math.round(totalSec * 1000);
	const h = Math.floor(totalMs / 3600000);
	const m = Math.floor((totalMs % 3600000) / 60000);
	const s = Math.floor((totalMs % 60000) / 1000);
	const ms = totalMs % 1000;
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

export function parseSrt(content: string): SrtEntry[] {
	const entries: SrtEntry[] = [];
	const blocks = content.trim().split(/\n\n+/);
	for (const block of blocks) {
		const lines = block.trim().split("\n");
		if (lines.length < 3) continue;
		if (!lines[1].includes(" --> ")) continue;
		entries.push({
			index: parseInt(lines[0], 10),
			time: lines[1],
			text: lines.slice(2).join("\n"),
		});
	}
	return entries;
}

export function fixOverlaps(entries: SrtEntry[]): SrtEntry[] {
	if (entries.length === 0) return entries;

	const parsed = entries.map((e) => {
		const [startStr, endStr] = e.time.split(" --> ");
		return {
			text: e.text,
			start: srtTimeToSeconds(startStr.trim()),
			end: srtTimeToSeconds(endStr.trim()),
		};
	});

	parsed.sort((a, b) => a.start - b.start);

	for (let i = 0; i < parsed.length - 1; i++) {
		if (parsed[i].end > parsed[i + 1].start) {
			parsed[i].end = parsed[i + 1].start;
		}
	}

	return parsed
		.filter((e) => e.end > e.start)
		.map((e, i) => ({
			index: i + 1,
			time: `${secondsToSrtTime(e.start)} --> ${secondsToSrtTime(e.end)}`,
			text: e.text,
		}));
}

export function sanitizeSrtText(text: string): string {
	return text
		.replace(/\r/g, "")
		.replace(/\n{2,}/g, "\n")
		.replace(/-->/g, "- >")
		.trim();
}

// Snap a Chinese split index to the nearest punctuation boundary (within ±4 chars).
// Prefers strong boundaries (。！？) over commas (，、) over weak (；：).
const ZH_PUNCT_STRONG = new Set(["。", "！", "？", "!", "?", ".", "\n"]);
const ZH_PUNCT_MID = new Set(["，", "、", ",", "—", "…"]);
const ZH_PUNCT_WEAK = new Set(["；", "：", ";", ":", " "]);

function snapZhBoundary(chars: string[], target: number, window = 4): number {
	const lo = Math.max(1, target - window);
	const hi = Math.min(chars.length - 1, target + window);
	let bestStrong = -1;
	let bestMid = -1;
	let bestWeak = -1;
	const dist = (i: number) => Math.abs(i - target);
	for (let i = lo; i <= hi; i++) {
		const ch = chars[i - 1];
		if (ZH_PUNCT_STRONG.has(ch)) {
			if (bestStrong === -1 || dist(i) < dist(bestStrong)) bestStrong = i;
		} else if (ZH_PUNCT_MID.has(ch)) {
			if (bestMid === -1 || dist(i) < dist(bestMid)) bestMid = i;
		} else if (ZH_PUNCT_WEAK.has(ch)) {
			if (bestWeak === -1 || dist(i) < dist(bestWeak)) bestWeak = i;
		}
	}
	if (bestStrong !== -1) return bestStrong;
	if (bestMid !== -1) return bestMid;
	if (bestWeak !== -1) return bestWeak;
	return target;
}

/**
 * Split a paired EN/ZH entry into chunks of at most `maxWords` English words.
 * Chinese is split at the nearest punctuation boundary to the proportional cut.
 * Time is distributed proportionally by English word count per chunk.
 */
export function splitEntryPair(
	en: SrtEntry,
	zh: SrtEntry,
	maxWords: number,
): { en: SrtEntry[]; zh: SrtEntry[] } {
	const [startStr, endStr] = en.time.split(" --> ");
	const start = srtTimeToSeconds(startStr.trim());
	const end = srtTimeToSeconds(endStr.trim());
	const duration = end - start;

	const enWords = en.text.split(/\s+/).filter(Boolean);
	if (enWords.length <= maxWords) {
		return { en: [en], zh: [zh] };
	}

	const zhChars = [...zh.text.replace(/\s\s+/g, " ")];
	const totalEnWords = enWords.length;
	const totalZhChars = zhChars.length;

	const enOut: SrtEntry[] = [];
	const zhOut: SrtEntry[] = [];
	let enIdx = 0;
	let zhIdx = 0;
	let seq = 0;

	while (enIdx < totalEnWords) {
		const chunkWords = enWords.slice(enIdx, enIdx + maxWords);
		const chunkStart = start + (enIdx / totalEnWords) * duration;
		const chunkEndWord = Math.min(enIdx + maxWords, totalEnWords);
		const chunkEnd = start + (chunkEndWord / totalEnWords) * duration;
		const time = `${secondsToSrtTime(chunkStart)} --> ${secondsToSrtTime(chunkEnd)}`;

		seq++;
		enOut.push({ index: seq, time, text: chunkWords.join(" ") });

		const isLast = chunkEndWord >= totalEnWords;
		let zhEndIdx: number;
		if (isLast) {
			zhEndIdx = totalZhChars;
		} else {
			const proportional =
				zhIdx + Math.round((chunkWords.length / totalEnWords) * totalZhChars);
			zhEndIdx = snapZhBoundary(
				zhChars,
				Math.min(proportional, totalZhChars - 1),
			);
			if (zhEndIdx <= zhIdx) zhEndIdx = Math.min(zhIdx + 1, totalZhChars);
		}
		const zhChunk = zhChars
			.slice(zhIdx, zhEndIdx)
			.join("")
			.replace(/^[，、,;\s]+/, "")
			.trim();
		zhOut.push({ index: seq, time, text: zhChunk || zh.text });
		zhIdx = zhEndIdx;

		enIdx += maxWords;
	}

	if (zhIdx < totalZhChars && zhOut.length > 0) {
		zhOut[zhOut.length - 1].text += zhChars.slice(zhIdx).join("");
	}

	return { en: enOut, zh: zhOut };
}

/**
 * Split all paired EN/ZH entries so no subtitle exceeds maxWords.
 * Entries must be aligned 1:1 (same length arrays).
 */
export function splitLongEntries(
	enEntries: SrtEntry[],
	zhEntries: SrtEntry[],
	maxWords: number,
): { en: SrtEntry[]; zh: SrtEntry[] } {
	const enOut: SrtEntry[] = [];
	const zhOut: SrtEntry[] = [];

	for (let i = 0; i < enEntries.length; i++) {
		const { en, zh } = splitEntryPair(
			enEntries[i],
			zhEntries[i],
			maxWords,
		);
		enOut.push(...en);
		zhOut.push(...zh);
	}

	// Re-index
	for (let i = 0; i < enOut.length; i++) {
		enOut[i].index = i + 1;
		zhOut[i].index = i + 1;
	}

	return { en: enOut, zh: zhOut };
}

export function formatSrt(entries: SrtEntry[]): string {
	return entries
		.map((e) => `${e.index}\n${e.time}\n${sanitizeSrtText(e.text)}\n`)
		.join("\n");
}
