import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { bookTasks } from '$lib/server/db/schema';
import { eq, and, asc } from 'drizzle-orm';

export const PATCH: RequestHandler = async ({ params, request, platform }) => {
	if (!platform) return json({ error: 'no platform' }, { status: 500 });
	const db = getDb(platform);
	const id = parseInt(params.id);
	const { status } = await request.json() as { status: string };

	await db.update(bookTasks).set({ status }).where(eq(bookTasks.id, id));

	// Get the task to find book_id
	const [task] = await db.select().from(bookTasks).where(eq(bookTasks.id, id)).limit(1);

	const tasks = await db
		.select()
		.from(bookTasks)
		.where(and(eq(bookTasks.book_id, task.book_id), eq(bookTasks.status, 'open')))
		.orderBy(asc(bookTasks.created_at));

	return json({ tasks });
};
