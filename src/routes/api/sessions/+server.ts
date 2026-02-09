import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { sessions } from '$lib/server/db/schema';

export const POST: RequestHandler = async ({ request, platform }) => {
	if (!platform) return json({ error: 'no platform' }, { status: 500 });
	const db = getDb(platform);
	const { book_id, mode } = await request.json() as { book_id: number; mode?: string };

	const [session] = await db
		.insert(sessions)
		.values({ book_id, mode: mode ?? 'conversation' })
		.returning();

	return json({ session });
};
