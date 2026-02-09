import { getDb, type Database } from '$lib/server/db';
import { chapters, paragraphs, projectNotes, bookTasks, sessions } from '$lib/server/db/schema';
import { eq, and, desc, asc } from 'drizzle-orm';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'anthropic/claude-sonnet-4-5';

export function defaultSystemPrompt(): string {
	return `You are a warm, supportive book writing partner and virtual publisher.

You have four roles:

**Interviewer**: Draw out the author's knowledge and stories with thoughtful questions.

**Editor**: Track tone and style consistency. Keep the voice authentically theirs.

**Organizer**: Maintain awareness of the book's structure. Propose where new content fits.

**Publisher / Author Coach**: Help the author understand the craft. Book metrics, reading level, market context.

Guidelines:
- Keep responses concise and conversational — this may be a voice conversation
- Ask one question at a time
- When the author shares content, acknowledge it warmly before asking follow-ups
- This is THEIR book — help them express their vision, not yours
- Be encouraging but honest

## Tools

You can take actions in the UI by including action tags in your response. They will be stripped from what the user sees and executed automatically.

Available actions:

**Navigate to a chapter:**
<<ACTION: {"tool": "go_to_chapter", "position": 2}>>

**Highlight/select a paragraph:**
<<ACTION: {"tool": "highlight_paragraph", "chapter_position": 1, "paragraph_position": 3}>>

**Add a paragraph to a chapter:**
<<ACTION: {"tool": "add_paragraph", "chapter_position": 1, "content": "The paragraph text goes here."}>>

**Edit an existing paragraph:**
<<ACTION: {"tool": "edit_paragraph", "chapter_position": 1, "paragraph_position": 2, "content": "The updated text."}>>

**Create a new chapter:**
<<ACTION: {"tool": "add_chapter", "title": "Chapter Title Here"}>>

**Set a chapter outline/plan:**
<<ACTION: {"tool": "set_outline", "chapter_position": 1, "content": "The outline text..."}>>

**Add a task/TODO:**
<<ACTION: {"tool": "add_task", "content": "Research historical context for Ch 3", "chapter_position": null}>>
chapter_position is optional — set it to associate the task with a chapter, or null for general tasks.

**Complete a task:**
<<ACTION: {"tool": "complete_task", "task_id": 123}>>

**Update project instructions (preferences, rules, style guides):**
<<ACTION: {"tool": "set_user_instructions", "content": "The full updated instructions text goes here"}>>
This replaces the entire user instructions. Read the current ones first, then append or modify as needed.

**Download a chapter:**
<<ACTION: {"tool": "download_chapter", "chapter_position": 1, "format": "pdf"}>>
format is "pdf" or "md" (markdown). Default is pdf.

**Download the entire book:**
<<ACTION: {"tool": "download_book", "format": "pdf"}>>

**Wrap up the session (save a summary for next time):**
<<ACTION: {"tool": "wrap_session", "summary": "We worked on chapters 1-3, decided on first-person POV..."}>>

Use these when the user asks you to navigate ("go to chapter 6"), add content ("write that down"), edit content ("change paragraph 3 to say..."), organize ("create a new chapter for recipes"), or export ("download chapter 3 as PDF"). You can include multiple actions in one response.

## Image & Diagram Placeholders

To mark where an image or diagram should go, add a paragraph with the format:
[IMAGE: description of the image or diagram]

For example: [IMAGE: Photo of the finished mushroom cultivation setup with labels]

These render as visual placeholder blocks in the manuscript. Use them when the author mentions wanting a picture, diagram, or illustration somewhere. You can also proactively suggest them when content would benefit from a visual.

## Notes

You can save notes for yourself between sessions:
<<NOTE_TO_SELF: your note here>>
These are stripped from what the user sees but saved for future context.`;
}

export async function buildSystemPrompt(db: Database, bookId: number): Promise<string> {
	let prompt = defaultSystemPrompt();

	// Current time
	prompt += `\n\n## Current Time\n${new Date().toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}`;

	// Full book content
	const chapterRows = await db
		.select()
		.from(chapters)
		.where(eq(chapters.book_id, bookId))
		.orderBy(asc(chapters.position));

	if (chapterRows.length > 0) {
		prompt += `\n\n## Full Manuscript`;
		for (const ch of chapterRows) {
			prompt += `\n\n### Chapter ${ch.position}: ${ch.title}`;
			if (ch.outline) {
				prompt += `\nOutline: ${ch.outline}`;
			}
			const paras = await db
				.select()
				.from(paragraphs)
				.where(eq(paragraphs.chapter_id, ch.id))
				.orderBy(asc(paragraphs.position));
			if (paras.length === 0) {
				prompt += `\n(no content yet)`;
			}
			for (const p of paras) {
				prompt += `\n\n[${p.position}] ${p.content}`;
			}
		}
	}

	// Feedback reminder — once per day
	const now = new Date();
	const today = now.toISOString().slice(0, 10);
	const [lastReminder] = await db
		.select()
		.from(projectNotes)
		.where(and(eq(projectNotes.book_id, bookId), eq(projectNotes.key, 'last_feedback_reminder')))
		.limit(1);

	const shouldRemind = !lastReminder?.value || lastReminder.value < today;
	if (shouldRemind) {
		prompt += `\n\n## Feedback Reminder\nThis is the first message today. Warmly remind the author (once, briefly) that they can share feedback or suggestions about this writing tool — what's working, what's not, what they wish it could do. Keep it to one sentence, woven naturally into your greeting. After this reminder, save a note so you don't remind again today.`;
		// Update the reminder date
		if (lastReminder) {
			await db
				.update(projectNotes)
				.set({ value: today })
				.where(eq(projectNotes.id, lastReminder.id));
		} else {
			await db.insert(projectNotes).values({
				book_id: bookId,
				key: 'last_feedback_reminder',
				value: today
			});
		}
	}

	// User instructions
	const [userInstr] = await db
		.select()
		.from(projectNotes)
		.where(and(eq(projectNotes.book_id, bookId), eq(projectNotes.key, 'user_instructions')))
		.limit(1);
	if (userInstr?.value) {
		prompt += `\n\n## User's Custom Instructions\n${userInstr.value}`;
	}

	// AI's own notes
	const [aiInstr] = await db
		.select()
		.from(projectNotes)
		.where(and(eq(projectNotes.book_id, bookId), eq(projectNotes.key, 'ai_instructions')))
		.limit(1);
	if (aiInstr?.value) {
		prompt += `\n\n## Your Own Notes (from previous sessions)\n${aiInstr.value}`;
	}

	// Open tasks
	const tasks = await db
		.select({
			id: bookTasks.id,
			content: bookTasks.content,
			chapter_id: bookTasks.chapter_id
		})
		.from(bookTasks)
		.where(and(eq(bookTasks.book_id, bookId), eq(bookTasks.status, 'open')))
		.orderBy(asc(bookTasks.created_at));

	if (tasks.length > 0) {
		// Get chapter positions for tasks with chapter_id
		const taskLines = await Promise.all(
			tasks.map(async (t) => {
				let chTag = '';
				if (t.chapter_id) {
					const [ch] = await db
						.select({ position: chapters.position })
						.from(chapters)
						.where(eq(chapters.id, t.chapter_id))
						.limit(1);
					if (ch) chTag = ` (Ch ${ch.position})`;
				}
				return `  - [${t.id}] ${t.content}${chTag}`;
			})
		);
		prompt += `\n\n## Open Tasks\n${taskLines.join('\n')}`;
	}

	// Previous session summary
	const sessionRows = await db
		.select()
		.from(sessions)
		.where(eq(sessions.book_id, bookId))
		.orderBy(desc(sessions.created_at))
		.limit(2);

	if (sessionRows.length >= 2) {
		// The current session is first, previous is second
		const prevSession = sessionRows[1];
		if (prevSession.summary) {
			prompt += `\n\n## Previous Session Summary\n${prevSession.summary}`;
		}
	}

	return prompt;
}

export async function* streamChat(
	messages: { role: string; content: string }[],
	systemPrompt: string,
	apiKey: string
): AsyncGenerator<string> {
	const fullMessages = [{ role: 'system', content: systemPrompt }, ...messages];

	const response = await fetch(OPENROUTER_URL, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			model: MODEL,
			messages: fullMessages,
			max_tokens: 1024,
			stream: true
		})
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`OpenRouter ${response.status}: ${text}`);
	}

	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = '';

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;

		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';

		for (const line of lines) {
			if (!line.startsWith('data: ')) continue;
			const data = line.slice(6).trim();
			if (data === '[DONE]') return;

			try {
				const parsed = JSON.parse(data);
				const content = parsed.choices?.[0]?.delta?.content;
				if (content) yield content;
			} catch {
				// skip malformed chunks
			}
		}
	}
}

export async function summarize(
	messages: { role: string; content: string }[],
	apiKey: string
): Promise<string> {
	const summaryPrompt = `Summarize this conversation concisely. Capture:
- Key topics and decisions made
- Important content/ideas shared for the book
- Any preferences or style notes mentioned
- Where we left off

Keep it under 300 words. This summary will replace the old messages to save context space.`;

	const fullMessages = [...messages, { role: 'user', content: summaryPrompt }];

	const response = await fetch(OPENROUTER_URL, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			model: MODEL,
			messages: fullMessages,
			max_tokens: 512
		})
	});

	if (!response.ok) {
		throw new Error(`OpenRouter ${response.status}`);
	}

	const json = await response.json() as any;
	return json.choices[0].message.content;
}
