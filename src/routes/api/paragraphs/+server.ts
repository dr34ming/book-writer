import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { paragraphs, chapters } from '$lib/server/db/schema';
import { eq, max } from 'drizzle-orm';

export const POST: RequestHandler = async ({ request, platform }) => {
	if (!platform) return json({ error: 'no platform' }, { status: 500 });
	const db = getDb(platform);
	const { chapter_id, content } = await request.json() as { chapter_id: number; content: string };

	// Next position
	const [maxPos] = await db
		.select({ max: max(paragraphs.position) })
		.from(paragraphs)
		.where(eq(paragraphs.chapter_id, chapter_id));
	const position = (maxPos?.max ?? 0) + 1;

	const [para] = await db
		.insert(paragraphs)
		.values({ chapter_id, content, position })
		.returning();

	return json({ paragraph: para });
};
