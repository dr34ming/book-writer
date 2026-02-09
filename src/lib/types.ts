export interface User {
	id: number;
	username: string;
	display_name: string;
}

export interface Book {
	id: number;
	title: string;
	description: string | null;
	user_id: number;
}

export interface Chapter {
	id: number;
	book_id: number;
	title: string;
	position: number;
	outline: string | null;
}

export interface Paragraph {
	id: number;
	chapter_id: number;
	content: string;
	position: number;
}

export interface Session {
	id: number;
	book_id: number;
	transcript: string | null;
	summary: string | null;
	mode: string;
}

export interface Message {
	id: number;
	session_id: number;
	role: 'user' | 'assistant' | 'system';
	content: string;
}

export interface ProjectNote {
	id: number;
	book_id: number;
	key: string;
	value: string | null;
}

export interface BookTask {
	id: number;
	book_id: number;
	chapter_id: number | null;
	content: string;
	status: string;
	source: string;
	chapter_position?: number | null;
}

export interface AIAction {
	tool: string;
	[key: string]: unknown;
}
