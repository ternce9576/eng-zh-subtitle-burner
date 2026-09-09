import { type SrtEntry, sanitizeSrtText, srtTimeToSeconds } from "./srt.js";
import { UNTRANSLATED } from "./translate/common.js";

/**
 * A line the translator failed on carries the UNTRANSLATED placeholder. Drop
 * it rather than rendering it — a missing subtitle beats a visible marker or,
 * worse, English text sitting in the Chinese track.
 */
function isRenderable(text: string): boolean {
	const t = text.trim();
	return t.length > 0 && !t.includes(UNTRANSLATED);
}

export interface AssOptions {
	noEnglish: boolean;
	enFontSize: number;
	zhFontSize: number;
	marginVEn: number;
	marginVZh: number;
	enFont: string;
	zhFont: string;
	/** Outline thickness. Gaming captions use a heavy stroke for legibility
	 *  over bright, busy footage. */
	outline: number;
}

function secondsToAssTime(totalSec: number): string {
	const totalMs = Math.round(totalSec * 1000);
	const h = Math.floor(totalMs / 3600000);
	const m = Math.floor((totalMs % 3600000) / 60000);
	const s = Math.floor((totalMs % 60000) / 1000);
	const cs = Math.floor((totalMs % 1000) / 10);
	return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

export function generateAss(
	enEntries: SrtEntry[],
	zhEntries: SrtEntry[],
	opts: AssOptions,
): string {
	const styles: string[] = [];
	// Field order: Name,Fontname,Fontsize,Primary,Secondary,Outline,Back,Bold,
	// Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,
	// Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
	// Styled to read as the same captioning system the creator already burns
	// into their footage: white, heavy, thick outline plus a drop shadow. The
	// Chinese style carries Bold=0 because its font supplies the weight
	// itself -- synthesising bold on top of a Black face smears the strokes.
	if (!opts.noEnglish) {
		styles.push(
			`Style: English,${opts.enFont},${opts.enFontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,${opts.outline},2,2,10,10,${opts.marginVEn},1`,
		);
	}
	styles.push(
		`Style: Chinese,${opts.zhFont},${opts.zhFontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,${opts.outline},2,2,10,10,${opts.marginVZh},1`,
	);

	const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 384
PlayResY: 288
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styles.join("\n")}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

	const lines: string[] = [header];

	if (!opts.noEnglish) {
		for (const entry of enEntries) {
			const [startStr, endStr] = entry.time.split(" --> ");
			const start = secondsToAssTime(srtTimeToSeconds(startStr.trim()));
			const end = secondsToAssTime(srtTimeToSeconds(endStr.trim()));
			const text = sanitizeSrtText(entry.text).replace(/\n/g, "\\N");
			lines.push(`Dialogue: 0,${start},${end},English,,0,0,0,,${text}`);
		}
	}

	for (const entry of zhEntries) {
		if (!isRenderable(entry.text)) continue;
		const [startStr, endStr] = entry.time.split(" --> ");
		const start = secondsToAssTime(srtTimeToSeconds(startStr.trim()));
		const end = secondsToAssTime(srtTimeToSeconds(endStr.trim()));
		const text = sanitizeSrtText(entry.text).replace(/\n/g, "\\N");
		lines.push(`Dialogue: 0,${start},${end},Chinese,,0,0,0,,${text}`);
	}

	return lines.join("\n") + "\n";
}
