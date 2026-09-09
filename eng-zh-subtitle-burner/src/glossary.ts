import { existsSync, readFileSync } from "node:fs";

export interface Glossary {
	/** Terms fed to whisper as hotwords, to bias decoding toward names it
	 *  would otherwise mishear. */
	hotwords: string;
	/** The same terms rendered for the translator's system prompt. */
	promptBlock: string;
	count: number;
}

export const EMPTY_GLOSSARY: Glossary = {
	hotwords: "",
	promptBlock: "",
	count: 0,
};

/**
 * A creator glossary is a plain text file, one term per line:
 *
 *     # anything after a hash is a comment
 *     Bed Wars => 起床战争      translate it this way, every time
 *     Hypixel                   a name: get it right, but leave it in English
 *
 * The same file serves two stages. The left-hand side biases transcription so
 * the term is heard correctly in the first place; the optional right-hand side
 * pins how it comes out in Chinese. Terms only ever get mistranscribed once
 * this way — without it the translator has to infer the right word from
 * context, which it often does, silently, and sometimes wrongly.
 */
export function loadGlossary(path?: string): Glossary {
	if (!path || !existsSync(path)) return EMPTY_GLOSSARY;

	const terms: { en: string; zh?: string }[] = [];
	for (const raw of readFileSync(path, "utf-8").split("\n")) {
		const line = raw.replace(/#.*$/, "").trim();
		if (!line) continue;
		const [en, zh] = line.split("=>").map((p) => p.trim());
		if (en) terms.push({ en, zh: zh || undefined });
	}
	if (terms.length === 0) return EMPTY_GLOSSARY;

	const translated = terms.filter((t) => t.zh);
	const kept = terms.filter((t) => !t.zh);

	const parts: string[] = [];
	if (translated.length > 0) {
		parts.push(
			"Fixed translations — use these exact renderings, never a synonym:",
			...translated.map((t) => `- ${t.en} → ${t.zh}`),
		);
	}
	if (kept.length > 0) {
		parts.push(
			"Proper nouns — keep these in English, spelled exactly like this:",
			...kept.map((t) => `- ${t.en}`),
		);
	}

	return {
		hotwords: terms.map((t) => t.en).join(" "),
		promptBlock: parts.join("\n"),
		count: terms.length,
	};
}
