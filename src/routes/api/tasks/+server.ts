import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { bookTasks } from '$lib/server/db/schema';
import { eq, and, asc } from 'drizzle-orm';
import { logEvent } from '$lib/server/events';

export const GET: RequestHandler = async ({ url, platform }) => {
	if (!platform) return json({ error: 'no platform' }, { status: 500 });
	const db = getDb(platform);
	const bookId = parseInt(url.searchParams.get('book_id') ?? '0');

	const tasks = await db
		.select()
		.from(bookTasks)
		.where(and(eq(bookTasks.book_id, bookId), eq(bookTasks.status, 'open')))
		.orderBy(asc(bookTasks.created_at));

	return json({ tasks });
};

export const POST: RequestHandler = async ({ request, platform }) => {
	if (!platform) return json({ error: 'no platform' }, { status: 500 });
	const db = getDb(platform);
	const { book_id, content, chapter_id, source } = await request.json() as { book_id: number; content: string; chapter_id?: number; source?: string };

	const [task] = await db.insert(bookTasks).values({
		book_id,
		content,
		chapter_id: chapter_id ?? null,
		source: source ?? 'user'
	}).returning();

	await logEvent(db, {
		book_id,
		action: 'add_task',
		entity_type: 'task',
		entity_id: task.id,
		after_state: task,
		source: (source as 'user' | 'ai') ?? 'user'
	});

	const tasks = await db
		.select()
		.from(bookTasks)
		.where(and(eq(bookTasks.book_id, book_id), eq(bookTasks.status, 'open')))
		.orderBy(asc(bookTasks.created_at));

	return json({ tasks });
};
