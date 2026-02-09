import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { chapters, paragraphs } from '$lib/server/db/schema';
import { eq, asc } from 'drizzle-orm';
import { logEvent } from '$lib/server/events';

export const GET: RequestHandler = async ({ params, platform }) => {
	if (!platform) return json({ error: 'no platform' }, { status: 500 });
	const db = getDb(platform);
	const id = parseInt(params.id);

	const [chapter] = await db.select().from(chapters).where(eq(chapters.id, id)).limit(1);
	if (!chapter) return json({ error: 'not found' }, { status: 404 });

	const paras = await db
		.select()
		.from(paragraphs)
		.where(eq(paragraphs.chapter_id, id))
		.orderBy(asc(paragraphs.position));

	// Word count for the book
	const allParas = await db
		.select({ content: paragraphs.content })
		.from(paragraphs)
		.innerJoin(chapters, eq(chapters.id, paragraphs.chapter_id))
		.where(eq(chapters.book_id, chapter.book_id));

	const wordCount = allParas.reduce(
		(sum, p) => sum + (p.content?.split(/\s+/).filter(Boolean).length ?? 0),
		0
	);

	return json({ chapter: { ...chapter, paragraphs: paras }, wordCount });
};

export const PATCH: RequestHandler = async ({ params, request, platform }) => {
	if (!platform) return json({ error: 'no platform' }, { status: 500 });
	const db = getDb(platform);
	const id = parseInt(params.id);
	const updates = await request.json() as Record<string, unknown>;

	const [before] = await db.select().from(chapters).where(eq(chapters.id, id)).limit(1);

	await db.update(chapters).set(updates as typeof chapters.$inferInsert).where(eq(chapters.id, id));

	const [chapter] = await db.select().from(chapters).where(eq(chapters.id, id)).limit(1);
	const paras = await db
		.select()
		.from(paragraphs)
		.where(eq(paragraphs.chapter_id, id))
		.orderBy(asc(paragraphs.position));

	if (before) {
		await logEvent(db, {
			book_id: chapter.book_id,
			action: 'edit_chapter',
			entity_type: 'chapter',
			entity_id: id,
			before_state: before,
			after_state: chapter
		});
	}

	return json({ chapter: { ...chapter, paragraphs: paras } });
};
