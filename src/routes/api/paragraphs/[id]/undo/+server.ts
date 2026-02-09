import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { paragraphs, chapters, events } from '$lib/server/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { logEvent } from '$lib/server/events';

export const POST: RequestHandler = async ({ params, platform }) => {
	if (!platform) return json({ error: 'no platform' }, { status: 500 });
	const db = getDb(platform);
	const id = parseInt(params.id);

	// Find the latest edit event for this paragraph that has a before_state
	const [event] = await db
		.select()
		.from(events)
		.where(
			and(
				eq(events.entity_type, 'paragraph'),
				eq(events.entity_id, id),
				eq(events.action, 'edit_paragraph')
			)
		)
		.orderBy(desc(events.created_at))
		.limit(1);

	if (!event?.before_state) {
		return json({ error: 'nothing to undo' }, { status: 404 });
	}

	const before = JSON.parse(event.before_state) as { content: string };
	const [current] = await db.select().from(paragraphs).where(eq(paragraphs.id, id)).limit(1);

	await db.update(paragraphs).set({ content: before.content }).where(eq(paragraphs.id, id));

	// Delete the event we just undid so next undo goes further back
	await db.delete(events).where(eq(events.id, event.id));

	const [restored] = await db.select().from(paragraphs).where(eq(paragraphs.id, id)).limit(1);
	const [chapter] = await db.select().from(chapters).where(eq(chapters.id, restored.chapter_id)).limit(1);

	// Log the undo as its own event
	await logEvent(db, {
		book_id: chapter.book_id,
		action: 'undo_edit_paragraph',
		entity_type: 'paragraph',
		entity_id: id,
		before_state: current,
		after_state: restored
	});

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

	return json({ paragraph: restored, wordCount });
};
