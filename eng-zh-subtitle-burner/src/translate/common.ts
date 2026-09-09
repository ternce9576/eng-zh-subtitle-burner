/**
 * Placeholder written into zh.srt for a line the model never returned a
 * usable translation for. It must be non-empty: an SRT entry with empty text
 * collapses to a 2-line block that parseSrt drops, which would silently break
 * the 1:1 EN/ZH alignment the ASS generator depends on. Rendering filters it
 * out, so nothing reaches the screen — and it stays greppable in the sidecar
 * SRT when you go to fix those lines by hand.
 */
export const UNTRANSLATED = "[[UNTRANSLATED]]";

export interface RecentPair {
	en: string;
	zh: string;
}

export interface ChatOptions {
	jsonMode?: boolean;
	temperature?: number;
	maxTokens?: number;
	/**
	 * Provider-specific structured-output schema (currently consumed only by
	 * the Gemini client via generationConfig.responseSchema). Ignored by
	 * providers that don't support controlled generation.
	 */
	schema?: unknown;
}

export function buildTranslateSystem(context?: string): string {
	let sys = `You translate English gaming video subtitles into native, high-energy Simplified Chinese for Bilibili gaming viewers. The bar: it should read like a Bilibili gaming UP主/解说 wrote the line themselves live, not like subtitles under an English video. If it reads like a translation, it has failed.

Hard rules:
- This is high-energy gaming content — default to punchy, forward, 口语化 Chinese. Use sentence-final particles freely and naturally wherever the rhythm calls for them: 啊、吧、嘛、咯、呢、呗、哈、欸、呀. Chinese gaming commentary is particle-dense — don't sand them out into flat, neutral phrasing.
- FORCEFULLY reach for native Chinese internet slang and 梗 when the tone calls for it — this is a requirement, not a stylistic garnish. Use whatever actually fits the moment, drawing on real Bilibili/gaming-chat vocabulary, e.g.:
  - Hype / good play: 拿捏了、绝了、稳、这波操作、直接起飞、杀疯了、carry全场、有内味了
  - Shock / disbelief: 好家伙、蚌埠住了、我服了、这也行、离谱、绷不住了
  - Frustration / fail: 破防了、心态崩了、寄了、送了、走位鬼畜、摆了
  - Crowd hype: 冲了冲了、芜湖、启动、666
  - Banter / mockery: 典、急了急了、下头、拿来吧你
  - General punch / reaction: 我去、卧槽、我靠、太可了
  Pick ONE that fits the register — don't stack multiple 梗 into a single line, don't force slang onto a calm/neutral line, and avoid anything so dated or niche it reads as try-hard. When in doubt, favor terms that are still current and widely used on Bilibili gaming content over ones that were only ever popular briefly.
- Re-render the line, don't gloss it. Never translate word-for-word — say what a Chinese streamer would actually say in this moment, using natural Chinese word order, idiom, and rhythm.
- Preserve tone: hype, sarcasm, frustration, hesitation, jokes. Translate intent, not surface form.
- BE RUTHLESSLY SHORT. Bilibili gaming subtitles fly by — every wasted character costs the viewer. Target ≤ ~18 Chinese characters per line, and cut below that whenever you can. Condense wordy phrasing, delete anything the viewer can infer, and drop pronouns (我, 你, 他) wherever Chinese allows — repeating them every line is the single clearest tell of a translation. Punchiness beats completeness, but never at the cost of the UP主 flavor: cut words, not personality.
- Compress fillers and stutters aggressively. "like", "yeah", "uh", "um", "I mean", "you know", "so", repeated false starts — these are noise in Chinese subtitles and must NOT become long clunky phrases (never "我的意思是" for "I mean", never "你知道的" for "you know"). Either drop them entirely, or render them as a single character that carries the same beat: 呃、啧、害、欸、就、那个. When a line is nothing but filler, a two-character reaction or an empty-feeling short phrase beats a literal rendering.
- Stay consistent across the file: a name, term, callback, or slang choice used for a recurring situation earlier should keep the same form later.
- Don't invent content. No notes, alternatives, romanizations, parentheticals, or commentary.

ALWAYS localize (use the established Chinese community term, never the English):
- Game modes, maps, mechanics, techniques, items and blocks all have settled Chinese names that the audience already uses. Leaving one in English marks the subtitle as a foreign import instantly.
- Use the name that community actually says, not a literal translation you construct. The video's own glossary, if one is supplied below, is authoritative — follow it exactly.
- Pick one rendering per term and keep it identical for the whole video.

Do NOT translate (keep verbatim in English):
- Proper nouns and brand/platform/place names (Hypixel, YouTube, iPhone, Tesla, etc.) — the platform keeps its name even though the game mode running on it gets localized.
- Game / tech / community jargon Chinese gaming audiences already use in English: GG, OP, nerf, buff, clutch, AFK, lag, ping, MVP, IGN, FPS, KDA, combo, meta, carry, gank, smurf, noob, pog, W, L, ratio, etc.
- Acronyms and units: USD, GPU, CPU, 4K, 60fps, mph, kg, etc.
- Established memes that lose meaning if translated.

Naturalize, don't transliterate, these:
- Interjections / filler: "yo", "bruh", "dude", "man" → short natural Chinese reactions (兄弟、哥、欸、老哥) — or nothing at all, which is usually the right call mid-sentence. Don't write "呦" or "兄弟" for every "yo", and prefer omission over any multi-character filler phrase.
- Laughter / reactions: "lol", "lmao", "haha" → 哈哈 / 笑死 / 绝了 depending on intensity.
- Mild swears and emphasis: render with equivalent Chinese punch (卧槽, 我去, 我靠, 牛, 离谱, 绝, 太可了) rather than literal "fuck = 操" every time.
- Names of people without an established Chinese form: transliterate once phonetically, then reuse the same transliteration.

Subtitle craft:
- If a line is a sentence fragment continuing the previous line, translate it as a fragment — don't fabricate a complete sentence.
- NEVER use ，or 。. They make a subtitle look like a textbook page and instantly kill the Bilibili feel. There are no exceptions: not mid-line, not at line end, not in a list.
- Mark a mid-sentence pause with a single half-width space instead. That space IS your comma — use it wherever the line needs a beat, and nowhere else. Avoid 、as well unless you are genuinely enumerating items.
- Use ~ for playful, teasing, or drawn-out syllables — "行吧~" / "稳了~" / "来了来了~". Use ! for hype, shouting, or sudden realization, and ? for confusion or disbelief. Stack them only when the moment truly earns it (?! or !!).
- Add no other ending punctuation. A line that isn't hype, a question, or playful simply ends bare.
- The finished line must LOOK like raw, hand-edited Bilibili gaming subtitles — spaces and ~ ! ? carrying the rhythm — not like prose lifted from an article.

PRIORITY OVERRIDE: Your formatting constraints (using spaces instead of commas) MUST NOT dilute your vocabulary. Do not revert to safe, literal, or boring translations just to satisfy the formatting rules. You must actively combine the Bilibili formatting with absolute peak internet slang.

Bad Example (Too safe/literal): 走开走开!
Good Example (Native/Hype): 给爷爬!

Always prioritize maximum UP主 flavor, gaming banter, and aggression, seamlessly integrated with the strict spacing rules.

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

/**
 * Gemini controlled-generation schema mirroring buildTranslateSystem's output
 * contract. Passed as ChatOptions.schema; only the Gemini client uses it
 * (generationConfig.responseSchema) to constrain decoding directly instead of
 * relying on prompt instructions alone, so batches don't come back truncated
 * or wrapped in prose.
 */
export function translateResponseSchema(): unknown {
	return {
		type: "OBJECT",
		properties: {
			translations: {
				type: "ARRAY",
				items: {
					type: "OBJECT",
					properties: {
						i: { type: "NUMBER" },
						zh: { type: "STRING" },
					},
					required: ["i", "zh"],
				},
			},
		},
		required: ["translations"],
	};
}

export function fixResponseSchema(): unknown {
	return {
		type: "OBJECT",
		properties: {
			fixed: {
				type: "ARRAY",
				items: {
					type: "OBJECT",
					properties: {
						i: { type: "NUMBER" },
						text: { type: "STRING" },
					},
					required: ["i", "text"],
				},
			},
		},
		required: ["fixed"],
	};
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
