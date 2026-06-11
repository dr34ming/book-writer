import { chapters, paragraphs, projectNotes, bookTasks, sessions } from '$lib/server/db/schema';
import { type Database } from '$lib/server/db';
import { eq, and, desc, asc } from 'drizzle-orm';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
// Configurable: swap for any current Claude model (e.g. claude-opus-4-6).
const MODEL = 'claude-sonnet-4-6';

// OpenAI-compatible tool definitions (source of truth).
// Translated to Anthropic's `tools` format in `toAnthropicTools`.
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

/**
 * The system prompt is split into two parts to make prompt caching effective:
 *
 *  - `stable`: the default prompt, full manuscript, user/AI notes, open tasks,
 *    and previous-session summary. This is byte-stable within a session, so it
 *    gets a `cache_control: ephemeral` marker and is read from cache (~90%
 *    cheaper, much faster) on every turn after the first.
 *
 *  - `volatile`: the current time and the once-per-day feedback reminder. These
 *    change turn-to-turn, so they're sent as a separate, uncached block AFTER
 *    the cached prefix — including them in the cached block would bust the cache
 *    every minute.
 *
 * Anthropic caches the longest matching prefix of content blocks, so order
 * matters: stable block first (cached), volatile block second (uncached).
 */
export type SystemPromptParts = { stable: string; volatile: string };

export async function buildSystemPrompt(db: Database, bookId: number): Promise<SystemPromptParts> {
	let prompt = defaultSystemPrompt();
	let volatile = '';

	// Current time — volatile, must stay out of the cached prefix.
	volatile += `## Current Time\n${new Date().toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}`;

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
		// Volatile: only present on the first message of the day, so it cannot
		// live in the cached prefix.
		volatile += `\n\n## Feedback Reminder\nThis is the first message today. Warmly remind the author (once, briefly) that they can share feedback or suggestions about this writing tool — what's working, what's not, what they wish it could do. Keep it to one sentence, woven naturally into your greeting. After this reminder, use save_note so you don't remind again today.`;
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

	return { stable: prompt, volatile };
}

// ---------------------------------------------------------------------------
// Anthropic Messages API
// ---------------------------------------------------------------------------

type AnthropicTextBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

/**
 * Translate the OpenAI-style TOOLS into Anthropic's `tools` format:
 *   { type:'function', function:{ name, description, parameters } }
 *     -> { name, description, input_schema }
 */
function toAnthropicTools() {
	return TOOLS.map((t) => ({
		name: t.function.name,
		description: t.function.description,
		input_schema: t.function.parameters
	}));
}

/**
 * Build the `system` field as an array of content blocks so we can attach
 * `cache_control` to the stable prefix only. Anthropic caches the longest
 * matching prefix of blocks; the volatile block (if any) is appended after the
 * cached marker and is therefore never cached.
 */
function buildSystemBlocks(system: string | SystemPromptParts): AnthropicTextBlock[] {
	const parts: SystemPromptParts =
		typeof system === 'string' ? { stable: system, volatile: '' } : system;

	const blocks: AnthropicTextBlock[] = [
		{ type: 'text', text: parts.stable, cache_control: { type: 'ephemeral' } }
	];
	if (parts.volatile.trim()) {
		blocks.push({ type: 'text', text: parts.volatile });
	}
	return blocks;
}

// Stream events surfaced to callers (shape unchanged from the OpenRouter impl).
export type StreamEvent =
	| { type: 'text'; content: string }
	| { type: 'tool_calls'; calls: Array<{ name: string; arguments: Record<string, unknown> }> };

export async function* streamChat(
	messages: { role: string; content: string }[],
	systemPrompt: string | SystemPromptParts,
	apiKey: string
): AsyncGenerator<StreamEvent> {
	const response = await fetch(ANTHROPIC_URL, {
		method: 'POST',
		headers: {
			'x-api-key': apiKey,
			'anthropic-version': ANTHROPIC_VERSION,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			model: MODEL,
			system: buildSystemBlocks(systemPrompt),
			messages: messages.map((m) => ({ role: m.role, content: m.content })),
			tools: toAnthropicTools(),
			max_tokens: 4096,
			stream: true
		})
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Anthropic ${response.status}: ${text}`);
	}

	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = '';

	// Track tool_use blocks by their content-block index. Anthropic streams the
	// JSON input as `input_json_delta` partial-JSON chunks per block.
	const toolBlocks = new Map<number, { name: string; partialJson: string }>();

	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;

		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed.startsWith('data:')) continue;
			const data = trimmed.slice(5).trim();
			if (!data || data === '[DONE]') continue;

			let parsed: any;
			try {
				parsed = JSON.parse(data);
			} catch {
				continue; // skip malformed chunks
			}

			switch (parsed.type) {
				case 'content_block_start': {
					const block = parsed.content_block;
					if (block?.type === 'tool_use') {
						toolBlocks.set(parsed.index, { name: block.name, partialJson: '' });
					}
					break;
				}
				case 'content_block_delta': {
					const delta = parsed.delta;
					if (delta?.type === 'text_delta' && delta.text) {
						yield { type: 'text', content: delta.text };
					} else if (delta?.type === 'input_json_delta') {
						const entry = toolBlocks.get(parsed.index);
						if (entry) entry.partialJson += delta.partial_json ?? '';
					}
					break;
				}
				case 'error': {
					throw new Error(`Anthropic stream error: ${JSON.stringify(parsed.error)}`);
				}
			}
		}
	}

	// Emit accumulated tool calls once the stream completes.
	if (toolBlocks.size > 0) {
		const calls = [...toolBlocks.values()]
			.filter((tc) => tc.name)
			.map((tc) => {
				try {
					const args = tc.partialJson.trim()
						? (JSON.parse(tc.partialJson) as Record<string, unknown>)
						: {};
					return { name: tc.name, arguments: args };
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

	// Anthropic requires the first message to be from the user and forbids a
	// trailing assistant turn for this prompt, so append the instruction as a
	// final user message.
	const fullMessages = [...messages, { role: 'user', content: summaryPrompt }];

	const response = await fetch(ANTHROPIC_URL, {
		method: 'POST',
		headers: {
			'x-api-key': apiKey,
			'anthropic-version': ANTHROPIC_VERSION,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			model: MODEL,
			messages: fullMessages.map((m) => ({ role: m.role, content: m.content })),
			max_tokens: 512
		})
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Anthropic ${response.status}: ${text}`);
	}

	const json = (await response.json()) as any;
	const textBlock = json.content?.find((b: any) => b.type === 'text');
	return textBlock?.text ?? '';
}
