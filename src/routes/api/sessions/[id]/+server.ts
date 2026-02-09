import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { sessions } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

export const PATCH: RequestHandler = async ({ params, request, platform }) => {
	if (!platform) return json({ error: 'no platform' }, { status: 500 });
	const db = getDb(platform);
	const id = parseInt(params.id);
	const updates = await request.json() as Record<string, unknown>;

	await db.update(sessions).set(updates as typeof sessions.$inferInsert).where(eq(sessions.id, id));

	const [session] = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);

	return json({ session });
};
