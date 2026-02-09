import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { messages as messagesTable, projectNotes } from '$lib/server/db/schema';
import { buildSystemPrompt, streamChat } from '$lib/server/ai';
import { extractActions, extractNotes } from '$lib/server/ai-actions';
import { eq, and } from 'drizzle-orm';
import { env } from '$env/dynamic/private';

export const POST: RequestHandler = async ({ request, platform }) => {
	const { messages, book_id, session_id } = await request.json() as { messages: Array<{ role: string; content: string }>; book_id: number; session_id: number };
	const apiKey = env.OPENROUTER_API_KEY;

	if (!apiKey) {
		return json({ error: 'OPENROUTER_API_KEY not set' }, { status: 500 });
	}

	if (!platform) {
		return json({ error: 'No platform (run with wrangler)' }, { status: 500 });
	}

	const db = getDb(platform);

	// Persist user message (the last one)
	const lastMsg = messages[messages.length - 1];
	if (lastMsg?.role === 'user') {
		await db.insert(messagesTable).values({
			session_id,
			role: 'user',
			content: lastMsg.content
		});
	}

	// Build system prompt
	const systemPrompt = await buildSystemPrompt(db, book_id);

	// Stream response as SSE
	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			try {
				// Emit context stats
				const estimateTokens = (text: string) => Math.ceil(text.length / 3.5);
				const chatText = messages.map((m: { content: string }) => m.content).join('');
				const systemTokens = estimateTokens(systemPrompt);
				const chatTokens = estimateTokens(chatText);
				controller.enqueue(
					encoder.encode(`data: ${JSON.stringify({
						type: 'stats',
						systemTokens,
						chatTokens,
						totalTokens: systemTokens + chatTokens,
						modelMax: 200000
					})}\n\n`)
				);

				let fullContent = '';

				for await (const token of streamChat(messages, systemPrompt, apiKey)) {
					fullContent += token;
					controller.enqueue(
						encoder.encode(`data: ${JSON.stringify({ type: 'token', content: token })}\n\n`)
					);
				}

				// Process complete response
				const { clean: afterNotes, notes } = extractNotes(fullContent);
				const { clean: cleanContent, actions } = extractActions(afterNotes);

				// Save notes to DB
				if (notes.length > 0 && book_id) {
					for (const note of notes) {
						// Get existing ai_instructions and append
						const [existing] = await db
							.select()
							.from(projectNotes)
							.where(
								and(
									eq(projectNotes.book_id, book_id),
									eq(projectNotes.key, 'ai_instructions')
								)
							)
							.limit(1);

						if (existing) {
							const newValue = existing.value ? `${existing.value}\n${note}` : note;
							await db
								.update(projectNotes)
								.set({ value: newValue })
								.where(eq(projectNotes.id, existing.id));
						} else {
							await db.insert(projectNotes).values({
								book_id,
								key: 'ai_instructions',
								value: note
							});
						}
					}

					// Send updated ai notes
					const [updated] = await db
						.select()
						.from(projectNotes)
						.where(
							and(
								eq(projectNotes.book_id, book_id),
								eq(projectNotes.key, 'ai_instructions')
							)
						)
						.limit(1);
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({ type: 'ai_notes', value: updated?.value })}\n\n`
						)
					);
				}

				// Persist assistant message (clean version)
				await db.insert(messagesTable).values({
					session_id,
					role: 'assistant',
					content: cleanContent
				});

				// Send actions if any
				if (actions.length > 0) {
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({ type: 'actions', actions })}\n\n`
						)
					);
				}

				controller.enqueue(encoder.encode('data: [DONE]\n\n'));
			} catch (err) {
				const message = err instanceof Error ? err.message : 'Unknown error';
				controller.enqueue(
					encoder.encode(
						`data: ${JSON.stringify({ type: 'error', message })}\n\n`
					)
				);
			} finally {
				controller.close();
			}
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive'
		}
	});
};
