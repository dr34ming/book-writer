import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { paragraphs, chapters } from '$lib/server/db/schema';
import { eq, max } from 'drizzle-orm';
import { logEvent } from '$lib/server/events';

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

	// Log event
	const [chapter] = await db.select().from(chapters).where(eq(chapters.id, chapter_id)).limit(1);
	if (chapter) {
		await logEvent(db, {
			book_id: chapter.book_id,
			action: 'add_paragraph',
			entity_type: 'paragraph',
			entity_id: para.id,
			after_state: para
		});
	}

	return json({ paragraph: para });
};
