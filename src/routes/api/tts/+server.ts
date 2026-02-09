import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { synthesize } from '$lib/server/tts';
import { env } from '$env/dynamic/private';

export const POST: RequestHandler = async ({ request }) => {
	const { text, voice } = await request.json() as { text: string; voice?: 'editor' | 'narrator' };
	const apiKey = env.ELEVENLABS_API_KEY;

	if (!apiKey) {
		return json({ error: 'ELEVENLABS_API_KEY not set' }, { status: 500 });
	}

	if (!text) {
		return json({ error: 'text required' }, { status: 400 });
	}

	try {
		return await synthesize(text, apiKey, voice ?? 'editor');
	} catch (err) {
		const message = err instanceof Error ? err.message : 'TTS error';
		return json({ error: message }, { status: 500 });
	}
};
