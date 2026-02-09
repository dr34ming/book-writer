import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { chapters, paragraphs } from '$lib/server/db/schema';
import { eq, asc, max } from 'drizzle-orm';

export const POST: RequestHandler = async ({ request, platform }) => {
	if (!platform) return json({ error: 'no platform' }, { status: 500 });
	const db = getDb(platform);
	const { book_id, title } = await request.json() as { book_id: number; title: string };

	// Next position
	const [maxPos] = await db
		.select({ max: max(chapters.position) })
		.from(chapters)
		.where(eq(chapters.book_id, book_id));
	const position = (maxPos?.max ?? 0) + 1;

	const [chapter] = await db
		.insert(chapters)
		.values({ book_id, title, position })
		.returning();

	const allChapters = await db
		.select()
		.from(chapters)
		.where(eq(chapters.book_id, book_id))
		.orderBy(asc(chapters.position));

	return json({
		chapter: { ...chapter, paragraphs: [] },
		chapters: allChapters
	});
};
