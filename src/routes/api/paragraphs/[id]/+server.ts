import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { paragraphs, chapters } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { logEvent } from '$lib/server/events';

export const PATCH: RequestHandler = async ({ params, request, platform }) => {
	if (!platform) return json({ error: 'no platform' }, { status: 500 });
	const db = getDb(platform);
	const id = parseInt(params.id);
	const { content } = await request.json() as { content: string };

	// Capture before state
	const [before] = await db.select().from(paragraphs).where(eq(paragraphs.id, id)).limit(1);

	await db.update(paragraphs).set({ content }).where(eq(paragraphs.id, id));

	// Get updated paragraph to find book for word count
	const [para] = await db.select().from(paragraphs).where(eq(paragraphs.id, id)).limit(1);
	if (!para) return json({ error: 'not found' }, { status: 404 });

	const [chapter] = await db
		.select()
		.from(chapters)
		.where(eq(chapters.id, para.chapter_id))
		.limit(1);

	// Word count
	const allParas = await db
		.select({ content: paragraphs.content })
		.from(paragraphs)
		.innerJoin(chapters, eq(chapters.id, paragraphs.chapter_id))
		.where(eq(chapters.book_id, chapter.book_id));

	const wordCount = allParas.reduce(
		(sum, p) => sum + (p.content?.split(/\s+/).filter(Boolean).length ?? 0),
		0
	);

	// Log event
	await logEvent(db, {
		book_id: chapter.book_id,
		action: 'edit_paragraph',
		entity_type: 'paragraph',
		entity_id: id,
		before_state: before,
		after_state: para
	});

	return json({ paragraph: para, wordCount });
};
