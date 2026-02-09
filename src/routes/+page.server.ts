import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import {
	books,
	chapters,
	paragraphs,
	sessions,
	projectNotes,
	bookTasks
} from '$lib/server/db/schema';
import { eq, and, asc, desc } from 'drizzle-orm';

export const load: PageServerLoad = async ({ locals, platform }) => {
	if (!locals.user) {
		return { loggedIn: false as const };
	}

	if (!platform) {
		// Dev without wrangler — return stub data
		return {
			loggedIn: true as const,
			book: { id: 1, title: 'Book Writer', description: null, user_id: 1 },
			chapters: [{ id: 1, book_id: 1, title: 'Introduction', position: 1, outline: null }],
			currentChapter: {
				id: 1,
				book_id: 1,
				title: 'Introduction',
				position: 1,
				outline: null,
				paragraphs: []
			},
			session: { id: 1, book_id: 1, mode: 'conversation', summary: null, transcript: null },
			tasks: [],
			wordCount: 0,
			userInstructions: '',
			aiInstructions: '',
			previousSessionSummary: null
		};
	}

	const db = getDb(platform);
	const userId = locals.user.id;

	// Get or create book for this user
	let [book] = await db
		.select()
		.from(books)
		.where(eq(books.user_id, userId))
		.limit(1);

	if (!book) {
		const [inserted] = await db
			.insert(books)
			.values({ title: 'My Book', user_id: userId })
			.returning();
		book = inserted;
	}

	// Get chapters
	let chapterRows = await db
		.select()
		.from(chapters)
		.where(eq(chapters.book_id, book.id))
		.orderBy(asc(chapters.position));

	if (chapterRows.length === 0) {
		const [ch] = await db
			.insert(chapters)
			.values({ book_id: book.id, title: 'Introduction', position: 1 })
			.returning();
		chapterRows = [ch];
	}

	// Get paragraphs for first chapter
	const currentChapterId = chapterRows[0].id;
	const paras = await db
		.select()
		.from(paragraphs)
		.where(eq(paragraphs.chapter_id, currentChapterId))
		.orderBy(asc(paragraphs.position));

	// Get or create session
	let [session] = await db
		.select()
		.from(sessions)
		.where(eq(sessions.book_id, book.id))
		.orderBy(desc(sessions.created_at))
		.limit(1);

	if (!session) {
		const [s] = await db
			.insert(sessions)
			.values({ book_id: book.id, mode: 'conversation' })
			.returning();
		session = s;
	}

	// Get tasks
	const taskRows = await db
		.select()
		.from(bookTasks)
		.where(and(eq(bookTasks.book_id, book.id), eq(bookTasks.status, 'open')))
		.orderBy(asc(bookTasks.created_at));

	// Get notes
	const [userInstrNote] = await db
		.select()
		.from(projectNotes)
		.where(and(eq(projectNotes.book_id, book.id), eq(projectNotes.key, 'user_instructions')))
		.limit(1);

	const [aiInstrNote] = await db
		.select()
		.from(projectNotes)
		.where(and(eq(projectNotes.book_id, book.id), eq(projectNotes.key, 'ai_instructions')))
		.limit(1);

	// Previous session summary
	let previousSessionSummary: string | null = null;
	const prevSessions = await db
		.select()
		.from(sessions)
		.where(eq(sessions.book_id, book.id))
		.orderBy(desc(sessions.created_at))
		.limit(2);

	if (prevSessions.length >= 2 && prevSessions[1].summary) {
		previousSessionSummary = prevSessions[1].summary;
	}

	// Word count
	const allParas = await db
		.select({ content: paragraphs.content })
		.from(paragraphs)
		.innerJoin(chapters, eq(chapters.id, paragraphs.chapter_id))
		.where(eq(chapters.book_id, book.id));

	const wordCount = allParas.reduce((sum, p) => {
		return sum + (p.content?.split(/\s+/).filter(Boolean).length ?? 0);
	}, 0);

	return {
		loggedIn: true as const,
		book,
		chapters: chapterRows,
		currentChapter: { ...chapterRows[0], paragraphs: paras },
		session,
		tasks: taskRows,
		wordCount,
		userInstructions: userInstrNote?.value ?? '',
		aiInstructions: aiInstrNote?.value ?? '',
		previousSessionSummary
	};
};
