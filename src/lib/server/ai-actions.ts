import type { AIAction } from '$lib/types';

export function extractNotes(content: string): { clean: string; notes: string[] } {
	const regex = /<<NOTE_TO_SELF:\s*(.*?)>>/gs;
	const notes: string[] = [];
	let match;
	while ((match = regex.exec(content)) !== null) {
		notes.push(match[1].trim());
	}
	const clean = content.replace(regex, '').trim();
	return { clean, notes };
}

export function extractActions(content: string): { clean: string; actions: AIAction[] } {
	const regex = /<<ACTION:\s*(.*?)>>/gs;
	const actions: AIAction[] = [];
	let match;
	while ((match = regex.exec(content)) !== null) {
		try {
			actions.push(JSON.parse(match[1].trim()));
		} catch {
			// skip malformed action JSON
		}
	}
	const clean = content.replace(regex, '').trim();
	return { clean, actions };
}
