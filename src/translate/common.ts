export interface RecentPair {
	en: string;
	zh: string;
}

export interface ChatOptions {
	jsonMode?: boolean;
	temperature?: number;
	maxTokens?: number;
}

export function buildTranslateSystem(context?: string): string {
	let sys = `You translate English video subtitles into natural, colloquial Simplified Chinese for native Chinese viewers. The goal is subtitles that feel like they were written by a Chinese native speaker — not a literal gloss of the English.

Hard rules:
- Match the speaker's register. Casual/spoken → 口语化 Chinese with natural particles (啊、吧、呢、嘛、咯、哈、欸). Formal/scripted → 书面 Chinese.
- Re-render the line. Never translate word-for-word. Use natural Chinese word order, idiom, and rhythm.
- Preserve tone: hype, sarcasm, frustration, hesitation, jokes. Translate intent, not surface form.
- Keep concise: target ≤ ~18 Chinese characters per line where possible; subtitles are read fast.
- Stay consistent across the file: a name, term, or callback used earlier should keep the same form.
- Don't invent content. No notes, alternatives, romanizations, parentheticals, or commentary.

Do NOT translate (keep verbatim in English):
- Proper nouns and brand/product/place names (Hypixel, Bedwars, YouTube, iPhone, Tesla, etc.).
- Game / tech / community jargon Chinese audiences already use in English: GG, OP, nerf, buff, clutch, AFK, lag, ping, MVP, IGN, FPS, KDA, combo, meta, carry, gank, smurf, noob, pog, W, L, ratio, etc.
- Acronyms and units: USD, GPU, CPU, 4K, 60fps, mph, kg, etc.
- Established memes that lose meaning if translated.

Naturalize, don't transliterate, these:
- Interjections / filler: "yo", "bruh", "dude", "man", "like", "you know" → render as natural Chinese reactions (兄弟、哥、欸、我跟你说、就是、那种) or omit when redundant. Don't write "呦" or "兄弟" for every "yo".
- Laughter / reactions: "lol", "lmao", "haha" → 哈哈 / 笑死 / 绝了 depending on intensity.
- Mild swears and emphasis: render with equivalent Chinese punch (卧槽, 我去, 我靠, 牛, 离谱, 绝, 太可了) rather than literal "fuck = 操" every time.
- Names of people without an established Chinese form: transliterate once phonetically, then reuse the same transliteration.

Subtitle craft:
- If a line is a sentence fragment continuing the previous line, translate it as a fragment — don't fabricate a complete sentence.
- Don't add ending punctuation that wasn't there; subtitle convention in Chinese omits 。at line end.
- Use 、，！？ where they help readability; avoid heavy punctuation.

Output format (strict):
Return a single JSON object with this exact shape and nothing else — no prose, no markdown fences, no comments:
{"translations":[{"i":0,"zh":"..."},{"i":1,"zh":"..."}, ...]}
Every input index must appear exactly once.`;

	if (context) {
		sys += `\n\nContext about this specific video (use to disambiguate slang, recognize proper nouns, and pick register):\n${context}`;
	}
	return sys;
}

export function buildTranslatePrompt(
	texts: string[],
	recent?: RecentPair[],
): string {
	let p = "";
	if (recent && recent.length > 0) {
		p +=
			"For continuity — recent lines already translated. DO NOT re-translate these; use them only to stay consistent on tone, names, and terminology:\n";
		for (const r of recent) {
			p += `EN: ${r.en.replace(/\s+/g, " ").trim()}\nZH: ${r.zh.replace(/\s+/g, " ").trim()}\n`;
		}
		p += "\n---\n\n";
	}
	p +=
		"Translate each numbered line below into natural Simplified Chinese. Reply with a single JSON object as specified — nothing else.\n\n";
	p += texts.map((t, i) => `[${i}] ${t}`).join("\n");
	return p;
}

export function buildFixSystem(context?: string): string {
	let sys = `You are a transcription proofreader. The input is automatic-speech-recognition output of an English video; some words are misheard.

Rules:
- Fix only words that were likely misheard — especially proper nouns, technical terms, brand names, slang, and uncommon vocabulary.
- Do NOT paraphrase, restructure, change tense, or "improve" grammar.
- Do NOT add or remove content. Do NOT add punctuation that wasn't there.
- Preserve the speaker's original casual register, contractions, filler words, and stutters.
- If a line is already correct, output it unchanged.

Output format (strict):
Return a single JSON object with this exact shape and nothing else — no prose, no markdown fences:
{"fixed":[{"i":0,"text":"..."},{"i":1,"text":"..."}, ...]}
Every input index must appear exactly once.`;

	if (context) {
		sys += `\n\nContext about this specific video (use to recognize misheard proper nouns and jargon):\n${context}`;
	}
	return sys;
}

export function buildFixPrompt(texts: string[]): string {
	return `Review and correct these subtitle lines. Reply with a single JSON object as specified — nothing else.\n\n${texts.map((t, i) => `[${i}] ${t}`).join("\n")}`;
}

function stripThinkTags(s: string): string {
	return s.replace(/<think>[\s\S]*?<\/think>/g, "");
}

function tryParseJson(raw: string): unknown | null {
	let s = stripThinkTags(raw).trim();
	s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
	try {
		return JSON.parse(s);
	} catch {}
	const i = s.indexOf("{");
	const j = s.lastIndexOf("}");
	if (i >= 0 && j > i) {
		try {
			return JSON.parse(s.slice(i, j + 1));
		} catch {}
	}
	return null;
}

interface ParseResult {
	result: string[];
	parsed: number;
	missing: number[];
}

function parseStructured(
	content: string,
	count: number,
	outerKey: "translations" | "fixed",
	innerKey: "zh" | "text",
): ParseResult {
	const result: string[] = new Array(count).fill("");
	const obj = tryParseJson(content) as Record<string, unknown> | null;

	if (obj && Array.isArray(obj[outerKey])) {
		for (const item of obj[outerKey] as unknown[]) {
			if (typeof item !== "object" || item === null) continue;
			const rec = item as Record<string, unknown>;
			const idx = typeof rec.i === "number" ? rec.i : Number(rec.i);
			const val = rec[innerKey];
			if (
				Number.isInteger(idx) &&
				idx >= 0 &&
				idx < count &&
				typeof val === "string"
			) {
				const trimmed = val.trim().replace(/\s*\n\s*/g, " ");
				if (trimmed) result[idx] = trimmed;
			}
		}
	}

	// Fallback: parse `[N] text` lines if JSON missed entries
	const stillEmpty = result.some((v) => !v);
	if (stillEmpty) {
		const cleaned = stripThinkTags(content);
		for (const line of cleaned.split("\n")) {
			const m = line.match(/^\s*\[(\d+)\]\s*(.+?)\s*$/);
			if (!m) continue;
			const idx = parseInt(m[1], 10);
			if (idx >= 0 && idx < count && !result[idx]) {
				const v = m[2].replace(/^["']|["'],?$/g, "").trim();
				if (v) result[idx] = v;
			}
		}
	}

	const missing: number[] = [];
	for (let i = 0; i < count; i++) if (!result[i]) missing.push(i);
	return { result, parsed: count - missing.length, missing };
}

export function parseTranslateResponse(
	content: string,
	count: number,
): ParseResult {
	return parseStructured(content, count, "translations", "zh");
}

export function parseFixResponse(
	content: string,
	count: number,
): ParseResult {
	return parseStructured(content, count, "fixed", "text");
}
