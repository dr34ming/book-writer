import { chapters, paragraphs, projectNotes, bookTasks, sessions } from '$lib/server/db/schema';
import { type Database } from '$lib/server/db';
import { eq, and, desc, asc } from 'drizzle-orm';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'anthropic/claude-sonnet-4-5';

// OpenAI-compatible tool definitions
export const TOOLS = [
	{
		type: 'function' as const,
		function: {
			name: 'go_to_chapter',
			description: 'Navigate to a chapter by its position number',
			parameters: {
				type: 'object',
				properties: {
					position: { type: 'integer', description: 'Chapter position number' }
				},
				required: ['position']
			}
		}
	},
	{
		type: 'function' as const,
		function: {
			name: 'highlight_paragraph',
			description: 'Highlight/select a specific paragraph in a chapter',
			parameters: {
				type: 'object',
				properties: {
					chapter_position: { type: 'integer' },
					paragraph_position: { type: 'integer' }
				},
				required: ['chapter_position', 'paragraph_position']
			}
		}
	},
	{
		type: 'function' as const,
		function: {
			name: 'add_paragraph',
			description: 'Add a new paragraph to a chapter. Use [IMAGE: description] format for image placeholders.',
			parameters: {
				type: 'object',
				properties: {
					chapter_position: { type: 'integer' },
					content: { type: 'string', description: 'The paragraph text' }
				},
				required: ['chapter_position', 'content']
			}
		}
	},
	{
		type: 'function' as const,
		function: {
			name: 'edit_paragraph',
			description: 'Edit an existing paragraph by replacing its content',
			parameters: {
				type: 'object',
				properties: {
					chapter_position: { type: 'integer' },
					paragraph_position: { type: 'integer' },
					content: { type: 'string', description: 'The new paragraph text' }
				},
				required: ['chapter_position', 'paragraph_position', 'content']
			}
		}
	},
	{
		type: 'function' as const,
		function: {
			name: 'add_chapter',
			description: 'Create a new chapter',
			parameters: {
				type: 'object',
				properties: {
					title: { type: 'string' }
				},
				required: ['title']
			}
		}
	},
	{
		type: 'function' as const,
		function: {
			name: 'set_outline',
			description: 'Set or update a chapter outline/plan',
			parameters: {
				type: 'object',
				properties: {
					chapter_position: { type: 'integer' },
					content: { type: 'string' }
				},
				required: ['chapter_position', 'content']
			}
		}
	},
	{
		type: 'function' as const,
		function: {
			name: 'add_task',
			description: 'Add a task/TODO item',
			parameters: {
				type: 'object',
				properties: {
					content: { type: 'string' },
					chapter_position: { type: 'integer', description: 'Optional — associate with a chapter' }
				},
				required: ['content']
			}
		}
	},
	{
		type: 'function' as const,
		function: {
			name: 'complete_task',
			description: 'Mark a task as done',
			parameters: {
				type: 'object',
				properties: {
					task_id: { type: 'integer' }
				},
				required: ['task_id']
			}
		}
	},
	{
		type: 'function' as const,
		function: {
			name: 'move_paragraph',
			description: 'Move a paragraph to a new position within its chapter',
			parameters: {
				type: 'object',
				properties: {
					chapter_position: { type: 'integer' },
					paragraph_position: { type: 'integer', description: 'Current position' },
					new_position: { type: 'integer' }
				},
				required: ['chapter_position', 'paragraph_position', 'new_position']
			}
		}
	},
	{
		type: 'function' as const,
		function: {
			name: 'set_user_instructions',
			description: 'Update the project instructions/preferences. Replaces the entire text.',
			parameters: {
				type: 'object',
				properties: {
					content: { type: 'string' }
				},
				required: ['content']
			}
		}
	},
	{
		type: 'function' as const,
		function: {
			name: 'download_chapter',
			description: 'Download a single chapter as PDF or Markdown',
			parameters: {
				type: 'object',
				properties: {
					chapter_position: { type: 'integer' },
					format: { type: 'string', enum: ['pdf', 'md'], description: 'Default: pdf' }
				},
				required: ['chapter_position']
			}
		}
	},
	{
		type: 'function' as const,
		function: {
			name: 'download_book',
			description: 'Download the entire book as PDF or Markdown',
			parameters: {
				type: 'object',
				properties: {
					format: { type: 'string', enum: ['pdf', 'md'], description: 'Default: pdf' }
				}
			}
		}
	},
	{
		type: 'function' as const,
		function: {
			name: 'wrap_session',
			description: 'Wrap up the current session and save a summary for next time',
			parameters: {
				type: 'object',
				properties: {
					summary: { type: 'string', description: 'Brief summary of what was discussed/accomplished' }
				},
				required: ['summary']
			}
		}
	},
	{
		type: 'function' as const,
		function: {
			name: 'new_session',
			description: 'End the current session and start a fresh one',
			parameters: {
				type: 'object',
				properties: {
					summary: { type: 'string', description: 'Summary of the session being ended' }
				},
				required: ['summary']
			}
		}
	},
	{
		type: 'function' as const,
		function: {
			name: 'save_note',
			description: 'Save a private note to yourself for future sessions. The user will not see this.',
			parameters: {
				type: 'object',
				properties: {
					note: { type: 'string' }
				},
				required: ['note']
			}
		}
	},
	{
		type: 'function' as const,
		function: {
			name: 'read_aloud',
			description: 'Read content aloud to the user with the narrator voice (male). Use this when the user asks you to read back a paragraph, section, or chapter. Provide the actual text content to read — do not reference positions, provide the full text. Keep to roughly one page max (~3000 chars).',
			parameters: {
				type: 'object',
				properties: {
					content: { type: 'string', description: 'The text to read aloud' }
				},
				required: ['content']
			}
		}
	}
];

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
- Use tools to take actions — navigate, add content, edit, organize, download, etc.
- You can call multiple tools in one response
- Use save_note to remember things between sessions (the user won't see these)

## Image & Diagram Placeholders

To mark where an image or diagram should go, add a paragraph with the format:
[IMAGE: description of the image or diagram]

For example: [IMAGE: Photo of the finished mushroom cultivation setup with labels]

These render as visual placeholder blocks in the manuscript. Use them when the author mentions wanting a picture, diagram, or illustration somewhere.`;
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
		prompt += `\n\n## Feedback Reminder\nThis is the first message today. Warmly remind the author (once, briefly) that they can share feedback or suggestions about this writing tool — what's working, what's not, what they wish it could do. Keep it to one sentence, woven naturally into your greeting. After this reminder, use save_note so you don't remind again today.`;
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
		const prevSession = sessionRows[1];
		if (prevSession.summary) {
			prompt += `\n\n## Previous Session Summary\n${prevSession.summary}`;
		}
	}

	return prompt;
}

// Stream events from OpenRouter
export type StreamEvent =
	| { type: 'text'; content: string }
	| { type: 'tool_calls'; calls: Array<{ name: string; arguments: Record<string, unknown> }> };

export async function* streamChat(
	messages: { role: string; content: string }[],
	systemPrompt: string,
	apiKey: string
): AsyncGenerator<StreamEvent> {
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
			tools: TOOLS,
			max_tokens: 4096,
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

	// Accumulate tool calls across chunks
	const toolCallMap = new Map<number, { name: string; arguments: string }>();

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;

		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';

		for (const line of lines) {
			if (!line.startsWith('data: ')) continue;
			const data = line.slice(6).trim();
			if (data === '[DONE]') break;

			try {
				const parsed = JSON.parse(data);
				const delta = parsed.choices?.[0]?.delta;
				if (!delta) continue;

				// Text content
				if (delta.content) {
					yield { type: 'text', content: delta.content };
				}

				// Tool calls (streamed as chunks)
				if (delta.tool_calls) {
					for (const tc of delta.tool_calls) {
						const idx = tc.index ?? 0;
						if (!toolCallMap.has(idx)) {
							toolCallMap.set(idx, { name: '', arguments: '' });
						}
						const entry = toolCallMap.get(idx)!;
						if (tc.function?.name) entry.name = tc.function.name;
						if (tc.function?.arguments) entry.arguments += tc.function.arguments;
					}
				}
			} catch {
				// skip malformed chunks
			}
		}
	}

	// Yield accumulated tool calls at the end
	if (toolCallMap.size > 0) {
		const calls = [...toolCallMap.values()]
			.filter(tc => tc.name)
			.map(tc => {
				try {
					return { name: tc.name, arguments: JSON.parse(tc.arguments) as Record<string, unknown> };
				} catch {
					return null;
				}
			})
			.filter((tc): tc is NonNullable<typeof tc> => tc !== null);

		if (calls.length > 0) {
			yield { type: 'tool_calls', calls };
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
