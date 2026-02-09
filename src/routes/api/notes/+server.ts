import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { projectNotes } from '$lib/server/db/schema';
import { eq, and } from 'drizzle-orm';
import { logEvent } from '$lib/server/events';

export const PUT: RequestHandler = async ({ request, platform }) => {
	if (!platform) return json({ error: 'no platform' }, { status: 500 });
	const db = getDb(platform);
	const { book_id, key, value } = await request.json() as { book_id: number; key: string; value: string };

	const [existing] = await db
		.select()
		.from(projectNotes)
		.where(and(eq(projectNotes.book_id, book_id), eq(projectNotes.key, key)))
		.limit(1);

	const beforeValue = existing?.value ?? null;

	if (existing) {
		await db.update(projectNotes).set({ value }).where(eq(projectNotes.id, existing.id));
	} else {
		await db.insert(projectNotes).values({ book_id, key, value });
	}

	await logEvent(db, {
		book_id,
		action: 'update_note',
		entity_type: 'note',
		before_state: { key, value: beforeValue },
		after_state: { key, value }
	});

	return json({ ok: true });
};
