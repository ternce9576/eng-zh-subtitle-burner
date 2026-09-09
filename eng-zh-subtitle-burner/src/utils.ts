export function formatDuration(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);
	if (h > 0) return `${h}h${m}m${s}s`;
	if (m > 0) return `${m}m${s}s`;
	return `${s}s`;
}

export function formatFileSize(bytes: number): string {
	if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
	if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
	return `${(bytes / 1e3).toFixed(0)} KB`;
}
