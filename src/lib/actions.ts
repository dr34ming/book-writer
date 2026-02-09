import type { AIAction, Chapter, Paragraph, BookTask } from '$lib/types';
import { downloadMarkdown, downloadPdf, type DownloadChapter } from '$lib/download';

export type PageState = {
	chapters: Chapter[];
	currentChapter: Chapter & { paragraphs: Paragraph[] };
	paragraphs: Paragraph[];
	tasks: BookTask[];
	selectedParagraph: number | null;
	editingParagraph: number | null;
	wordCount: number;
	session: { id: number };
	messages: { role: string; content: string }[];
	previousSessionSummary: string | null;
	bookId: number;
	bookTitle: string;
	userInstructions: string;
};

type StateUpdater = (fn: (state: PageState) => Partial<PageState>) => void;

export function summarizeAction(action: AIAction): string {
	switch (action.tool) {
		case 'go_to_chapter':
			return 'Switched chapters';
		case 'highlight_paragraph':
			return 'Highlighted a paragraph';
		case 'add_paragraph':
			return 'Added a paragraph';
		case 'edit_paragraph':
			return 'Edited a paragraph';
		case 'add_chapter':
			return `Created a chapter`;
		case 'set_outline':
			return 'Updated the outline';
		case 'add_task':
			return 'Added a task';
		case 'complete_task':
			return 'Completed a task';
		case 'wrap_session':
			return 'Wrapped up the session';
		case 'new_session':
			return 'Started a new session';
		case 'move_paragraph':
			return 'Moved a paragraph';
		case 'download_chapter':
			return 'Downloaded a chapter';
		case 'download_book':
			return 'Downloaded the book';
		case 'set_user_instructions':
			return 'Updated project instructions';
		default:
			return action.tool.replace(/_/g, ' ');
	}
}

export async function executeActions(
	actions: AIAction[],
	state: PageState,
	update: StateUpdater
): Promise<string[]> {
	const summaries: string[] = [];
	for (const action of actions) {
		summaries.push(summarizeAction(action));
		await executeAction(action, state, update);
	}
	return summaries;
}

async function executeAction(
	action: AIAction,
	state: PageState,
	update: StateUpdater
): Promise<void> {
	switch (action.tool) {
		case 'go_to_chapter': {
			const pos = action.position as number;
			const chapter = state.chapters.find((c) => c.position === pos);
			if (!chapter) return;
			const resp = await fetch(`/api/chapters/${chapter.id}`);
			if (!resp.ok) return;
			const data = await resp.json() as any;
			update(() => ({
				currentChapter: data.chapter,
				paragraphs: data.chapter.paragraphs,
				selectedParagraph: null,
				editingParagraph: null
			}));
			break;
		}
		case 'highlight_paragraph': {
			const chPos = action.chapter_position as number;
			const pPos = action.paragraph_position as number;
			const chapter = state.chapters.find((c) => c.position === chPos);
			if (!chapter) return;
			const resp = await fetch(`/api/chapters/${chapter.id}`);
			if (!resp.ok) return;
			const data = await resp.json() as any;
			const para = data.chapter.paragraphs.find(
				(p: Paragraph) => p.position === pPos
			);
			update(() => ({
				currentChapter: data.chapter,
				paragraphs: data.chapter.paragraphs,
				selectedParagraph: para?.id ?? null
			}));
			break;
		}
		case 'add_paragraph': {
			const chPos = action.chapter_position as number;
			const content = action.content as string;
			const chapter = state.chapters.find((c) => c.position === chPos);
			if (!chapter) return;
			const resp = await fetch('/api/paragraphs', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ chapter_id: chapter.id, content })
			});
			if (!resp.ok) return;
			const data = await resp.json() as any;
			// Refresh current chapter if it matches
			if (chapter.id === state.currentChapter.id) {
				const chResp = await fetch(`/api/chapters/${chapter.id}`);
				if (chResp.ok) {
					const chData = await chResp.json() as any;
					update(() => ({
						currentChapter: chData.chapter,
						paragraphs: chData.chapter.paragraphs,
						wordCount: chData.wordCount
					}));
				}
			}
			break;
		}
		case 'edit_paragraph': {
			const chPos = action.chapter_position as number;
			const pPos = action.paragraph_position as number;
			const content = action.content as string;
			const chapter = state.chapters.find((c) => c.position === chPos);
			if (!chapter) return;
			// Find paragraph by position
			const chResp = await fetch(`/api/chapters/${chapter.id}`);
			if (!chResp.ok) return;
			const chData = await chResp.json() as any;
			const para = chData.chapter.paragraphs.find(
				(p: Paragraph) => p.position === pPos
			);
			if (!para) return;
			await fetch(`/api/paragraphs/${para.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ content })
			});
			// Refresh
			if (chapter.id === state.currentChapter.id) {
				const freshResp = await fetch(`/api/chapters/${chapter.id}`);
				if (freshResp.ok) {
					const freshData = await freshResp.json() as any;
					update(() => ({
						currentChapter: freshData.chapter,
						paragraphs: freshData.chapter.paragraphs,
						wordCount: freshData.wordCount
					}));
				}
			}
			break;
		}
		case 'add_chapter': {
			const title = action.title as string;
			const resp = await fetch('/api/chapters', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ book_id: state.bookId, title })
			});
			if (!resp.ok) return;
			const data = await resp.json() as any;
			update(() => ({
				chapters: data.chapters,
				currentChapter: data.chapter,
				paragraphs: data.chapter.paragraphs ?? []
			}));
			break;
		}
		case 'set_outline': {
			const chPos = action.chapter_position as number;
			const content = action.content as string;
			const chapter = state.chapters.find((c) => c.position === chPos);
			if (!chapter) return;
			await fetch(`/api/chapters/${chapter.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ outline: content })
			});
			if (chapter.id === state.currentChapter.id) {
				const freshResp = await fetch(`/api/chapters/${chapter.id}`);
				if (freshResp.ok) {
					const freshData = await freshResp.json() as any;
					update(() => ({
						currentChapter: freshData.chapter,
						paragraphs: freshData.chapter.paragraphs
					}));
				}
			}
			break;
		}
		case 'add_task': {
			const content = action.content as string;
			const chPos = action.chapter_position as number | null;
			let chapter_id: number | null = null;
			if (chPos) {
				const ch = state.chapters.find((c) => c.position === chPos);
				if (ch) chapter_id = ch.id;
			}
			const resp = await fetch('/api/tasks', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					book_id: state.bookId,
					content,
					chapter_id,
					source: 'ai'
				})
			});
			if (!resp.ok) return;
			const data = await resp.json() as any;
			update(() => ({ tasks: data.tasks }));
			break;
		}
		case 'complete_task': {
			const taskId = action.task_id as number;
			await fetch(`/api/tasks/${taskId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ status: 'done' })
			});
			// Refresh tasks
			const resp = await fetch(`/api/tasks?book_id=${state.bookId}`);
			if (resp.ok) {
				const data = await resp.json() as any;
				update(() => ({ tasks: data.tasks }));
			}
			break;
		}
		case 'move_paragraph': {
			const chPos = action.chapter_position as number;
			const pPos = action.paragraph_position as number;
			const newPos = action.new_position as number;
			const chapter = state.chapters.find((c) => c.position === chPos);
			if (!chapter) return;
			const chResp = await fetch(`/api/chapters/${chapter.id}`);
			if (!chResp.ok) return;
			const chData = await chResp.json() as any;
			const para = chData.chapter.paragraphs.find(
				(p: Paragraph) => p.position === pPos
			);
			if (!para) return;
			await fetch(`/api/paragraphs/${para.id}/move`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ position: newPos })
			});
			if (chapter.id === state.currentChapter.id) {
				const freshResp = await fetch(`/api/chapters/${chapter.id}`);
				if (freshResp.ok) {
					const freshData = await freshResp.json() as any;
					update(() => ({
						currentChapter: freshData.chapter,
						paragraphs: freshData.chapter.paragraphs
					}));
				}
			}
			break;
		}
		case 'set_user_instructions': {
			const content = action.content as string;
			await fetch('/api/notes', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					book_id: state.bookId,
					key: 'user_instructions',
					value: content
				})
			});
			update(() => ({ userInstructions: content }));
			break;
		}
		case 'download_chapter': {
			const chPos = action.chapter_position as number;
			const format = (action.format as string) ?? 'pdf';
			const chapter = state.chapters.find((c) => c.position === chPos);
			if (!chapter) return;
			const resp = await fetch(`/api/chapters/${chapter.id}`);
			if (!resp.ok) return;
			const data = await resp.json() as any;
			const ch: DownloadChapter = {
				position: chapter.position,
				title: chapter.title,
				outline: data.chapter.outline,
				paragraphs: data.chapter.paragraphs ?? []
			};
			if (format === 'md') {
				downloadMarkdown(`${state.bookTitle} - ${chapter.title}`, [ch]);
			} else {
				downloadPdf(`${state.bookTitle} - ${chapter.title}`, [ch]);
			}
			break;
		}
		case 'download_book': {
			const format = (action.format as string) ?? 'pdf';
			const allChapters: DownloadChapter[] = [];
			for (const ch of state.chapters) {
				const resp = await fetch(`/api/chapters/${ch.id}`);
				if (!resp.ok) continue;
				const data = await resp.json() as any;
				allChapters.push({
					position: ch.position,
					title: ch.title,
					outline: data.chapter.outline,
					paragraphs: data.chapter.paragraphs ?? []
				});
			}
			if (format === 'md') {
				downloadMarkdown(state.bookTitle, allChapters);
			} else {
				downloadPdf(state.bookTitle, allChapters);
			}
			break;
		}
		case 'wrap_session': {
			const summary = action.summary as string;
			const resp = await fetch(`/api/sessions/${state.session.id}/wrap`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ summary, book_id: state.bookId })
			});
			if (resp.ok) {
				const data = await resp.json() as any;
				update(() => ({
					session: data.session,
					messages: [],
					previousSessionSummary: summary
				}));
			}
			break;
		}
		case 'new_session': {
			// Wrap current session first (if there are messages), then start fresh
			if (state.messages.filter(m => m.role !== 'action').length > 0) {
				await fetch(`/api/sessions/${state.session.id}/wrap`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						summary: (action.summary as string) ?? 'Session ended by AI.',
						book_id: state.bookId
					})
				});
			}
			// Create new session
			const resp = await fetch('/api/sessions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ book_id: state.bookId })
			});
			if (resp.ok) {
				const data = await resp.json() as any;
				update(() => ({
					session: data.session,
					messages: [],
					previousSessionSummary: (action.summary as string) ?? null
				}));
			}
			break;
		}
	}
}
