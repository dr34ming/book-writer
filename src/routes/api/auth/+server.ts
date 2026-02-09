import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, cookies }) => {
	const { username } = (await request.json()) as { username: string };

	if (!username) {
		return json({ error: 'username required' }, { status: 400 });
	}

	cookies.set('user', username, { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 60 * 60 * 24 * 365 });
	return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ cookies }) => {
	cookies.delete('user', { path: '/' });
	return json({ ok: true });
};
