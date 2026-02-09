import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import {
	books,
	chapters,
	sessions,
	projectNotes
} from '$lib/server/db/schema';
import { eq, and, asc, desc } from 'drizzle-orm';

export const load: PageServerLoad = async ({ locals, platform }) => {
	if (!locals.user) {
		return { loggedIn: false as const };
	}

	if (!platform) {
		return {
			loggedIn: true as const,
			book: { id: 1, title: 'Book Writer', description: null, user_id: 1 },
			chapters: [{ id: 1, book_id: 1, title: 'Introduction', position: 1, outline: null }],
			session: { id: 1, book_id: 1, mode: 'conversation', summary: null, transcript: null },
			userInstructions: '',
			previousSessionSummary: null
		};
	}

	const db = getDb(platform);
	const userId = locals.user.id;

	let [book] = await db.select().from(books).where(eq(books.user_id, userId)).limit(1);
	if (!book) {
		const [inserted] = await db.insert(books).values({ title: 'My Book', user_id: userId }).returning();
		book = inserted;
	}

	let chapterRows = await db.select().from(chapters).where(eq(chapters.book_id, book.id)).orderBy(asc(chapters.position));
	if (chapterRows.length === 0) {
		const [ch] = await db.insert(chapters).values({ book_id: book.id, title: 'Introduction', position: 1 }).returning();
		chapterRows = [ch];
	}

	let [session] = await db.select().from(sessions).where(eq(sessions.book_id, book.id)).orderBy(desc(sessions.created_at)).limit(1);
	if (!session) {
		const [s] = await db.insert(sessions).values({ book_id: book.id, mode: 'conversation' }).returning();
		session = s;
	}

	const [userInstrNote] = await db.select().from(projectNotes)
		.where(and(eq(projectNotes.book_id, book.id), eq(projectNotes.key, 'user_instructions'))).limit(1);

	let previousSessionSummary: string | null = null;
	const prevSessions = await db.select().from(sessions).where(eq(sessions.book_id, book.id)).orderBy(desc(sessions.created_at)).limit(2);
	if (prevSessions.length >= 2 && prevSessions[1].summary) {
		previousSessionSummary = prevSessions[1].summary;
	}

	return {
		loggedIn: true as const,
		book,
		chapters: chapterRows,
		session,
		userInstructions: userInstrNote?.value ?? '',
		previousSessionSummary
	};
};
