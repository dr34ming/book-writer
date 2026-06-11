import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { messages as messagesTable, projectNotes } from '$lib/server/db/schema';
import { buildSystemPrompt, streamChat } from '$lib/server/ai';
import { research, formatResearchResult } from '$lib/server/research';
import { eq, and } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { logEvent } from '$lib/server/events';

// Cap research round-trips per user turn so a misbehaving model can't loop
// forever calling the search API.
const MAX_RESEARCH_ROUNDS = 3;

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
				// Everything streamed to the author across all passes, so the
				// persisted message matches what they actually saw on screen.
				let streamedSoFar = '';

				// `convo` is the running message list sent to the model. Research
				// round-trips append synthetic turns to it (assistant ack + a
				// user-framed tool result) and re-invoke the model so it can
				// synthesize a natural answer from REAL sources. The raw search
				// results are never streamed to the client — only the model's
				// synthesized text reaches the author.
				const braveKey = env.BRAVE_SEARCH_API_KEY;
				let convo: Array<{ role: string; content: string }> = messages;
				let round = 0;

				researchLoop: for (;;) {
					let pendingResearch: { query: string } | null = null;

					for await (const event of streamChat(convo, systemPrompt, apiKey)) {
					if (event.type === 'text') {
						fullContent += event.content;
						streamedSoFar += event.content;
						controller.enqueue(
							encoder.encode(`data: ${JSON.stringify({ type: 'token', content: event.content })}\n\n`)
						);
					} else if (event.type === 'tool_calls') {
						// Separate save_note / research from UI actions
						const uiActions = [];
						for (const call of event.calls) {
							if (call.name === 'research') {
								// Server-side, model round-trip. We only honour the
								// first research call per pass; additional calls in
								// the same pass fall through to the next round.
								const query = String(call.arguments.query ?? '').trim();
								if (query && !pendingResearch) {
									pendingResearch = { query };
								}
							} else if (call.name === 'save_note') {
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

					// No research requested this pass — the turn is complete.
					if (!pendingResearch || round >= MAX_RESEARCH_ROUNDS) {
						break researchLoop;
					}

					round += 1;

					// Surface the research step in the client action log (the query
					// only — never the raw results).
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({
								type: 'actions',
								actions: [{ tool: 'research', query: pendingResearch.query }]
							})}\n\n`
						)
					);

					// Run the real search and frame it as a tool result for the
					// model. The author never sees this text.
					const result = await research(pendingResearch.query, braveKey);
					const resultText = formatResearchResult(result);

					// Continue the conversation: record what the model already said
					// (so it isn't lost), then hand it the results to synthesize
					// from. Anthropic requires a non-empty assistant turn, so fall
					// back to an internal note if the model only emitted a tool call.
					convo = [
						...convo,
						{
							role: 'assistant',
							content: fullContent.trim() || `(Looking up: ${pendingResearch.query})`
						},
						{
							role: 'user',
							content: `[research results — internal, the author cannot see this]\n\n${resultText}`
						}
					];
					// Reset streamed text for the synthesis pass.
					fullContent = '';
				}

				// Persist assistant message — the full text the author saw across
				// all research round-trips (raw search results were never streamed).
				await db.insert(messagesTable).values({
					session_id,
					role: 'assistant',
					content: streamedSoFar
				});

				// Log chat event
				const chatSnapshot = [...messages, { role: 'assistant', content: streamedSoFar }];
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
