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
		"You translate YouTube video titles into Chinese for Bilibili.",
		"",
		"Rules:",
		"- Write the title a Chinese gaming UP主 would actually post. Not a literal translation — a title that makes someone click.",
		"- Keep it under 40 Chinese characters. Bilibili truncates past that.",
		"- Keep the hook. If the English title is a challenge, a reveal, or a number, keep that shape.",
		"- Use the established Chinese term for games, modes and items, never the English.",
		"- No ，or 。 Use a space for a pause. ! and ? are fine, and ? carries disbelief well.",
		"- Do NOT add 【中字】, 搬运, or any tag-like prefix. That is added separately.",
		"- Output the title and nothing else. No quotes, no alternatives, no explanation.",
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
