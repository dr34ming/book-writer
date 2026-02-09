import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { messages as messagesTable, projectNotes } from '$lib/server/db/schema';
import { buildSystemPrompt, streamChat } from '$lib/server/ai';
import { eq, and } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { logEvent } from '$lib/server/events';

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

				for await (const event of streamChat(messages, systemPrompt, apiKey)) {
					if (event.type === 'text') {
						fullContent += event.content;
						controller.enqueue(
							encoder.encode(`data: ${JSON.stringify({ type: 'token', content: event.content })}\n\n`)
						);
					} else if (event.type === 'tool_calls') {
						// Separate save_note calls from UI actions
						const uiActions = [];
						for (const call of event.calls) {
							if (call.name === 'save_note') {
								// Handle save_note server-side
								const note = call.arguments.note as string;
								if (note) {
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
										await db.update(projectNotes).set({ value: newValue }).where(eq(projectNotes.id, existing.id));
									} else {
										await db.insert(projectNotes).values({ book_id, key: 'ai_instructions', value: note });
									}

									// Send updated notes to client
									const [updated] = await db
										.select()
										.from(projectNotes)
										.where(and(eq(projectNotes.book_id, book_id), eq(projectNotes.key, 'ai_instructions')))
										.limit(1);
									controller.enqueue(
										encoder.encode(`data: ${JSON.stringify({ type: 'ai_notes', value: updated?.value })}\n\n`)
									);
								}
							} else {
								// Convert to action format: { tool: name, ...arguments }
								uiActions.push({ tool: call.name, ...call.arguments });
							}
						}

						// Send UI actions to client
						if (uiActions.length > 0) {
							controller.enqueue(
								encoder.encode(`data: ${JSON.stringify({ type: 'actions', actions: uiActions })}\n\n`)
							);
						}
					}
				}

				// Persist assistant message
				await db.insert(messagesTable).values({
					session_id,
					role: 'assistant',
					content: fullContent
				});

				// Log chat event
				const chatSnapshot = [...messages, { role: 'assistant', content: fullContent }];
				await logEvent(db, {
					book_id,
					session_id,
					action: 'chat_message',
					entity_type: 'session',
					entity_id: session_id,
					chat_snapshot: chatSnapshot,
					source: 'ai'
				});

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
