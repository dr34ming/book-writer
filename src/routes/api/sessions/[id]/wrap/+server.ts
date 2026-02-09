import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { sessions } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { summarize } from '$lib/server/ai';
import { env } from '$env/dynamic/private';

export const POST: RequestHandler = async ({ params, request, platform }) => {
	if (!platform) return json({ error: 'no platform' }, { status: 500 });
	const db = getDb(platform);
	const id = parseInt(params.id);
	const { book_id, messages, summary: providedSummary } = await request.json() as { book_id: number; messages: Array<{ role: string; content: string }>; summary?: string };

	const apiKey = env.OPENROUTER_API_KEY;
	let summary = providedSummary;

	// If no summary provided, generate one
	if (!summary && messages?.length > 0 && apiKey) {
		summary = await summarize(messages, apiKey);
	}

	// Save summary to current session
	await db.update(sessions).set({ summary }).where(eq(sessions.id, id));

	// Create new session
	const [newSession] = await db
		.insert(sessions)
		.values({ book_id, mode: 'conversation' })
		.returning();

	return json({ session: newSession, summary });
};
