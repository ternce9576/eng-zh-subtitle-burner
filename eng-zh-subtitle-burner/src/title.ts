import { chatGemini } from "./translate/gemini.js";
import { loadGlossary } from "./glossary.js";

/**
 * Translates one video title for the Bilibili submission form.
 *
 * A title is not a subtitle line: it has to survive on a thumbnail grid with
 * no surrounding context, and it is the single biggest lever on whether the
 * video gets clicked. So it gets its own prompt rather than reusing the
 * subtitle system message, which is tuned for short spoken fragments.
 */
export async function translateTitle(
	title: string,
	apiKey: string,
	model: string,
	context?: string,
	glossaryPath?: string,
): Promise<string> {
	const glossary = loadGlossary(glossaryPath);

	const system = [
		"You write Bilibili video titles. You are given a YouTube title in English and you write the Chinese title the video will be posted under.",
		"",
		"This is not a translation task. The English title was written to win a click on YouTube's homepage; you are writing to win a click on Bilibili's, against different competition, for a different audience. Keep the hook, throw away the wording.",
		"",
		"What makes a Bilibili gaming title work:",
		"- Front-load it. The first 8-10 characters are what survives on a phone. Put the surprising thing there, never a setup clause.",
		"- Write from 我. First person carries the whole platform: 我 + what you did + what happened.",
		"- The payoff belongs in the title. Chinese gaming titles tell you the outcome and make you want to see how — they do not tease with 'you won't believe'.",
		"- Use the searchable Chinese name of the game. 我的世界 finds more viewers than Minecraft. Use both only if the title still reads naturally.",
		"- Keep real numbers. 100天, 7天, 1000万 are strong hooks and strong search terms.",
		"- End on ？ or ！ when the moment earns it. ？ carries disbelief and pulls harder than a full stop.",
		"- Words that reliably land: 居然, 结果, 差点, 翻车, 离谱, 硬控, 破防, 全场, 直接. Use at most one — stacking them reads as a content farm.",
		"",
		"Hard rules:",
		"- 20-30 Chinese characters. Under 20 looks thin, over 30 gets cut off.",
		"- No ，or 。 A single space is the pause. ！ and ？ are fine.",
		"- Never 【中字】, 搬运, 熟肉 or any bracketed prefix. That is handled separately.",
		"- Never invent facts that are not in the English title.",
		"- Use the established Chinese term for every game, mode and item.",
		"- Output the title alone. No quotes, no alternatives, no commentary.",
		context ? `\nAbout this channel:\n${context}` : "",
		glossary.promptBlock ? `\n${glossary.promptBlock}` : "",
	]
		.filter(Boolean)
		.join("\n");

	const out = await chatGemini(system, title, apiKey, model);
	// A model that ignores "nothing else" usually adds a line of commentary
	// underneath, so take the first non-empty line and strip stray quoting.
	return (
		out
			.split("\n")
			.map((l) => l.trim())
			.find((l) => l.length > 0)
			?.replace(/^["'「『]|["'」』]$/g, "") ?? title
	);
}
