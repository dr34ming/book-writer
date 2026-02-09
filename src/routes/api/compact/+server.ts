import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { summarize } from '$lib/server/ai';
import { env } from '$env/dynamic/private';

export const POST: RequestHandler = async ({ request }) => {
	const { messages } = await request.json() as { messages: Array<{ role: string; content: string }> };
	const apiKey = env.OPENROUTER_API_KEY;

	if (!apiKey) {
		return json({ error: 'OPENROUTER_API_KEY not set' }, { status: 500 });
	}

	const summary = await summarize(messages, apiKey);
	return json({ summary });
};
