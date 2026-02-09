<script lang="ts">
	import type { PageData } from './$types';
	import type { Chapter, Paragraph, BookTask, AIAction } from '$lib/types';
	import { executeActions, summarizeAction, type PageState } from '$lib/actions';
	import { downloadMarkdown, downloadPdf, type DownloadChapter } from '$lib/download';
	import { startListening, pauseListening, stopListening, stopSpeaking, queueSentence, flushQueue, isSpeaking } from '$lib/voice';

	let { data }: { data: PageData } = $props();

	let loginInput = $state('');

	async function login(username: string) {
		await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username }) });
		window.location.reload();
	}

	async function logout() {
		await fetch('/api/auth', { method: 'DELETE' });
		window.location.reload();
	}

	// State — only valid when logged in
	const loggedIn = data.loggedIn;
	const d = loggedIn ? data : null;
	let book = $state(d?.book ?? { id: 0, title: '', description: null, user_id: 0 });
	let chapters = $state(d?.chapters ?? []);
	let currentChapter = $state(d?.currentChapter ?? { id: 0, book_id: 0, title: '', position: 1, outline: null, paragraphs: [] });
	let paragraphs = $state(d?.currentChapter?.paragraphs ?? []);
	let session = $state(d?.session ?? { id: 0, book_id: 0, mode: 'conversation', summary: null, transcript: null });
	let messages = $state<{ role: string; content: string }[]>([]);
	let tasks = $state(d?.tasks ?? []);
	let wordCount = $state(d?.wordCount ?? 0);
	let userInstructions = $state(d?.userInstructions ?? '');
	let aiInstructions = $state(d?.aiInstructions ?? '');
	let previousSessionSummary = $state(d?.previousSessionSummary ?? null);
	let currentUser = $state(data.user?.username ?? '');

	// UI state
	let voiceOn = $state(false);
	let muted = $state(false);
	let aiLoading = $state(false);
	let aiSpeaking = $state(false);
	let abortController: AbortController | null = null;

	// Context stats
	let contextStats = $state<{ systemTokens: number; chatTokens: number; totalTokens: number; modelMax: number } | null>(null);

	function stopAI() {
		if (abortController) {
			abortController.abort();
			abortController = null;
		}
		stopSpeaking();
		aiLoading = false;
		aiSpeaking = false;
		if (voiceOn && !muted) {
			startListening((text) => sendMessage(text));
		}
	}
	let inputText = $state('');
	let selectedParagraph = $state<number | null>(null);
	let editingParagraph = $state<number | null>(null);
	let editingOutline = $state(false);
	let showSettings = $state(false);
	let showTasks = $state(false);

	// Refs
	let chatContainer: HTMLDivElement;
	let manuscriptContainer: HTMLDivElement;

	// Flash/scroll state
	let flashParagraphId = $state<number | null>(null);
	let flashTimeout: ReturnType<typeof setTimeout> | null = null;

	function scrollToAndFlash(paraId: number) {
		flashParagraphId = paraId;
		if (flashTimeout) clearTimeout(flashTimeout);
		flashTimeout = setTimeout(() => { flashParagraphId = null; }, 2500);
		requestAnimationFrame(() => {
			const el = document.getElementById(`paragraph-${paraId}`);
			if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
		});
	}

	// Voice effects
	$effect(() => {
		if (voiceOn && !muted) {
			startListening((text) => sendMessage(text));
		} else {
			pauseListening();
		}
	});

	$effect(() => {
		if (!voiceOn) {
			stopListening();
			stopSpeaking();
		}
	});

	// Auto-scroll chat
	$effect(() => {
		if (messages.length > 0 && chatContainer) {
			// Reading messages.length triggers reactivity
			requestAnimationFrame(() => {
				chatContainer.scrollTop = chatContainer.scrollHeight;
			});
		}
	});

	// Compaction threshold
	const COMPACT_THRESHOLD = 20;

	async function sendMessage(text: string) {
		if (!text.trim()) return;

		const userMsg = { role: 'user', content: text.trim() };
		messages = [...messages, userMsg];
		inputText = '';
		aiLoading = true;

		// Stream AI response
		try {
			abortController = new AbortController();
			const resp = await fetch('/api/chat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					messages: messages.filter((m) => m.role !== 'action').map((m) => ({ role: m.role, content: m.content })),
					book_id: book.id,
					session_id: session.id
				}),
				signal: abortController.signal
			});

			if (!resp.ok) {
				messages = [
					...messages,
					{ role: 'assistant', content: `Sorry, I had trouble responding (${resp.status}).` }
				];
				aiLoading = false;
				return;
			}

			// SSE streaming
			const reader = resp.body!.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			let fullContent = '';
			let assistantAdded = false;
			let firstSentenceSent = false;
			let firstSentenceEnd = -1; // char index where first sentence ends in fullContent

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';

				for (const line of lines) {
					if (!line.startsWith('data: ')) continue;
					const data = line.slice(6);

					if (data === '[DONE]') continue;

					try {
						const parsed = JSON.parse(data);

						if (parsed.type === 'stats') {
							contextStats = { systemTokens: parsed.systemTokens, chatTokens: parsed.chatTokens, totalTokens: parsed.totalTokens, modelMax: parsed.modelMax };
						} else if (parsed.type === 'token') {
							fullContent += parsed.content;
							if (!assistantAdded) {
								messages = [...messages, { role: 'assistant', content: fullContent }];
								assistantAdded = true;
							} else {
								messages = messages.map((m, i) =>
									i === messages.length - 1 ? { ...m, content: fullContent } : m
								);
							}
							// Fire first sentence to TTS as soon as it's complete
							if (voiceOn && !muted && !firstSentenceSent) {
								const match = fullContent.match(/[.!?]\s/);
								if (match && match.index !== undefined) {
									firstSentenceEnd = match.index + 1;
									firstSentenceSent = true;
									aiSpeaking = true;
									queueSentence(fullContent.slice(0, firstSentenceEnd));
								}
							}
						} else if (parsed.type === 'actions') {
							// Execute AI actions
							const state = getPageState();
							const summaries = await executeActions(parsed.actions, state, (fn) => {
								const updates = fn(state);
								if (updates.chapters) chapters = updates.chapters as typeof chapters;
								if (updates.currentChapter) {
									currentChapter = updates.currentChapter as typeof currentChapter;
									paragraphs =
										(updates.currentChapter as typeof currentChapter).paragraphs ?? [];
								}
								if (updates.paragraphs)
									paragraphs = updates.paragraphs as typeof paragraphs;
								if (updates.tasks) tasks = updates.tasks as typeof tasks;
								if (updates.selectedParagraph !== undefined)
									selectedParagraph = updates.selectedParagraph as number | null;
								if (updates.editingParagraph !== undefined)
									editingParagraph = updates.editingParagraph as number | null;
								if (updates.wordCount !== undefined)
									wordCount = updates.wordCount as number;
								if (updates.session) session = updates.session as typeof session;
								if (updates.messages) messages = updates.messages as typeof messages;
								if (updates.previousSessionSummary !== undefined)
									previousSessionSummary = updates.previousSessionSummary as string | null;
								if (updates.userInstructions !== undefined)
									userInstructions = updates.userInstructions as string;
							});
							for (const summary of summaries) {
								messages = [...messages, { role: 'action', content: summary }];
							}
							// Scroll to and flash affected paragraphs
							for (const action of parsed.actions as Array<{ tool: string; [k: string]: unknown }>) {
								if (action.tool === 'highlight_paragraph' && selectedParagraph) {
									requestAnimationFrame(() => scrollToAndFlash(selectedParagraph!));
								} else if (action.tool === 'add_paragraph') {
									// New paragraph is last in list
									const last = paragraphs[paragraphs.length - 1];
									if (last) requestAnimationFrame(() => scrollToAndFlash(last.id));
								} else if (action.tool === 'edit_paragraph') {
									const pos = action.paragraph_position as number;
									const para = paragraphs.find((p) => p.position === pos);
									if (para) requestAnimationFrame(() => scrollToAndFlash(para.id));
								}
							}
						} else if (parsed.type === 'ai_notes') {
							aiInstructions = parsed.value ?? aiInstructions;
						} else if (parsed.type === 'error') {
							if (!assistantAdded) {
								messages = [
									...messages,
									{ role: 'assistant', content: `Error: ${parsed.message}` }
								];
							}
						}
					} catch {
						// skip malformed
					}
				}
			}

			aiLoading = false;
			abortController = null;

			// TTS: send remainder (everything after first sentence) as one chunk
			if (voiceOn && !muted) {
				if (firstSentenceSent && firstSentenceEnd < fullContent.length) {
					const remainder = fullContent.slice(firstSentenceEnd).trim();
					if (remainder) queueSentence(remainder);
				} else if (!firstSentenceSent && fullContent.trim()) {
					aiSpeaking = true;
					queueSentence(fullContent.trim());
				}
				flushQueue(() => {
					aiSpeaking = false;
					if (voiceOn && !muted) {
						startListening((text) => sendMessage(text));
					}
				});
			}

			// Maybe compact
			if (messages.length >= COMPACT_THRESHOLD) {
				compactMessages();
			}
		} catch (err) {
			if ((err as Error).name === 'AbortError') {
				// User hit stop — that's fine
				abortController = null;
				return;
			}
			console.error('Chat error:', err);
			messages = [
				...messages,
				{ role: 'assistant', content: 'Sorry, something went wrong.' }
			];
			aiLoading = false;
			abortController = null;
		}
	}

	async function compactMessages() {
		try {
			const resp = await fetch('/api/compact', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					messages: messages.slice(0, -6).filter((m) => m.role !== 'action').map((m) => ({ role: m.role, content: m.content }))
				})
			});
			if (resp.ok) {
				const data = await resp.json() as any;
				const recent = messages.slice(-6);
				messages = [
					{ role: 'system', content: `[Previous conversation summary]\n${data.summary}` },
					...recent
				];
			}
		} catch {
			// compaction failed, keep going
		}
	}

	function getPageState(): PageState {
		return {
			chapters,
			currentChapter,
			paragraphs,
			tasks,
			selectedParagraph,
			editingParagraph,
			wordCount,
			session,
			messages,
			previousSessionSummary,
			bookId: book.id,
		bookTitle: book.title,
		userInstructions
		};
	}

	// Chapter navigation
	async function selectChapter(id: number) {
		const resp = await fetch(`/api/chapters/${id}`);
		if (!resp.ok) return;
		const data = await resp.json() as any;
		currentChapter = data.chapter;
		paragraphs = data.chapter.paragraphs;
		selectedParagraph = null;
		editingParagraph = null;
		editingOutline = false;
	}

	// Add chapter
	async function addChapter(event: SubmitEvent) {
		const form = event.target as HTMLFormElement;
		const formData = new FormData(form);
		const title = formData.get('title') as string;
		if (!title?.trim()) return;

		const resp = await fetch('/api/chapters', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ book_id: book.id, title: title.trim() })
		});
		if (!resp.ok) return;
		const data = await resp.json() as any;
		chapters = data.chapters;
		currentChapter = data.chapter;
		paragraphs = data.chapter.paragraphs ?? [];
		form.reset();
	}

	// Save outline
	async function saveOutline(event: SubmitEvent) {
		const form = event.target as HTMLFormElement;
		const formData = new FormData(form);
		const outline = formData.get('outline') as string;

		await fetch(`/api/chapters/${currentChapter.id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ outline })
		});

		currentChapter = { ...currentChapter, outline } as typeof currentChapter;
		editingOutline = false;
	}

	// Paragraph editing
	async function saveParagraph(paraId: number, content: string) {
		const resp = await fetch(`/api/paragraphs/${paraId}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ content })
		});
		if (!resp.ok) return;
		const data = await resp.json() as any;
		paragraphs = paragraphs.map((p) => (p.id === paraId ? { ...p, content } : p));
		wordCount = data.wordCount;
		editingParagraph = null;
	}

	// Tasks
	async function addTask(event: SubmitEvent) {
		const form = event.target as HTMLFormElement;
		const formData = new FormData(form);
		const content = formData.get('content') as string;
		if (!content?.trim()) return;

		const resp = await fetch('/api/tasks', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ book_id: book.id, content: content.trim(), source: 'user' })
		});
		if (!resp.ok) return;
		const data = await resp.json() as any;
		tasks = data.tasks;
		form.reset();
	}

	async function toggleTask(id: number) {
		const task = tasks.find((t) => t.id === id);
		if (!task) return;
		const newStatus = task.status === 'open' ? 'done' : 'open';
		const resp = await fetch(`/api/tasks/${id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: newStatus })
		});
		if (!resp.ok) return;
		const data = await resp.json() as any;
		tasks = data.tasks;
	}

	// Settings
	async function saveSettings(event: SubmitEvent) {
		const form = event.target as HTMLFormElement;
		const formData = new FormData(form);
		const instructions = formData.get('user_instructions') as string;

		await fetch('/api/notes', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				book_id: book.id,
				key: 'user_instructions',
				value: instructions
			})
		});
		userInstructions = instructions;
		showSettings = false;
	}

	// Session wrap
	async function wrapSession() {
		aiLoading = true;
		try {
			const resp = await fetch(`/api/sessions/${session.id}/wrap`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					book_id: book.id,
					messages: messages.filter((m) => m.role !== 'action').map((m) => ({ role: m.role, content: m.content }))
				})
			});
			if (!resp.ok) {
				aiLoading = false;
				return;
			}
			const data = await resp.json() as any;
			session = data.session;
			previousSessionSummary = data.summary;
			messages = [];
		} catch {
			// wrap failed
		}
		aiLoading = false;
	}

	// Download book
	let downloadFormat = $state<'md' | 'pdf'>('pdf');

	async function downloadBook() {
		const allChapters: DownloadChapter[] = [];
		for (const ch of chapters) {
			const resp = await fetch(`/api/chapters/${ch.id}`);
			if (!resp.ok) continue;
			const data = await resp.json() as any;
			allChapters.push({
				position: ch.position,
				title: ch.title,
				outline: data.chapter.outline,
				paragraphs: data.chapter.paragraphs ?? []
			});
		}
		if (downloadFormat === 'md') {
			downloadMarkdown(book.title, allChapters);
		} else {
			downloadPdf(book.title, allChapters);
		}
	}

	// Handle send form
	function handleSend(event: SubmitEvent) {
		event.preventDefault();
		sendMessage(inputText);
	}

	// Handle paragraph save form
	function handleParagraphSave(event: SubmitEvent, paraId: number) {
		event.preventDefault();
		const form = event.target as HTMLFormElement;
		const formData = new FormData(form);
		const content = formData.get('content') as string;
		saveParagraph(paraId, content);
	}
</script>

{#if !loggedIn}
<div class="flex items-center justify-center h-screen bg-base-200">
	<div class="card bg-base-100 shadow-xl w-80">
		<div class="card-body items-center text-center">
			<h2 class="card-title text-2xl mb-4">Book Writer</h2>
			<form onsubmit={(e) => { e.preventDefault(); if (loginInput.trim()) login(loginInput.trim()); }} class="w-full">
				<input
					type="text"
					bind:value={loginInput}
					placeholder="Enter your name"
					class="input input-bordered w-full mb-3"
					autofocus
				/>
				<button type="submit" class="btn btn-primary w-full" disabled={!loginInput.trim()}>Log in</button>
			</form>
		</div>
	</div>
</div>
{:else}
<div class="flex h-screen bg-base-100">
	<!-- LEFT: Chat / Conversation -->
	<div class="w-[380px] flex flex-col border-r border-base-300 bg-base-200">
		<!-- Header -->
		<div class="p-4 border-b border-base-300">
			<div class="flex items-center justify-between">
				<h2 class="font-bold text-lg">{book.title}</h2>
				<div class="flex items-center gap-2">
					<button
						onclick={() => (showTasks = !showTasks)}
						class="btn btn-ghost btn-xs"
						title="Tasks"
					>
						<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
						</svg>
						{#if tasks.length > 0}
							<span class="badge badge-xs badge-primary">{tasks.length}</span>
						{/if}
					</button>
					{#if messages.length > 0}
						<button
							onclick={wrapSession}
							class="btn btn-ghost btn-xs"
							title="Wrap up session"
						>
							<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
							</svg>
						</button>
					{/if}
					<button
						onclick={() => (showSettings = !showSettings)}
						class="btn btn-ghost btn-xs"
						title="Settings"
					>
						<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
						</svg>
					</button>
					<button onclick={logout} class="badge badge-sm badge-ghost cursor-pointer hover:badge-error" title="Log out">{currentUser} &times;</button>
				</div>
			</div>
			<div class="flex items-center gap-3 mt-1">
				<span class="text-sm text-base-content/60">{wordCount.toLocaleString()} words</span>
				{#if contextStats}
					<span class="text-xs text-base-content/30" title="System: {contextStats.systemTokens.toLocaleString()}  Chat: {contextStats.chatTokens.toLocaleString()}">
						{(contextStats.totalTokens / 1000).toFixed(1)}k / {contextStats.modelMax / 1000}k tokens
					</span>
					<progress
						class="progress progress-xs w-16 {contextStats.totalTokens / contextStats.modelMax > 0.8 ? 'progress-warning' : contextStats.totalTokens / contextStats.modelMax > 0.95 ? 'progress-error' : 'progress-info'}"
						value={contextStats.totalTokens}
						max={contextStats.modelMax}
					></progress>
				{/if}
			</div>
		</div>

		<!-- Settings Panel -->
		{#if showSettings}
			<div class="border-b border-base-300 bg-base-100 p-4">
				<form onsubmit={saveSettings}>
					<div class="mb-3">
						<label class="label text-sm font-semibold" for="user-instructions">Your Instructions</label>
						<textarea
							id="user-instructions"
							name="user_instructions"
							class="textarea textarea-bordered w-full text-sm"
							rows="4"
							placeholder="Tell the AI how you want it to behave, what your book is about, tone preferences, etc."
						>{userInstructions}</textarea>
					</div>
					{#if aiInstructions}
						<div class="mb-3">
							<label class="label text-sm font-semibold">AI's Own Notes</label>
							<div class="text-sm text-base-content/60 bg-base-200 rounded p-3 whitespace-pre-wrap">
								{aiInstructions}
							</div>
						</div>
					{/if}
					<div class="flex gap-2">
						<button type="submit" class="btn btn-sm btn-primary">Save</button>
						<button type="button" onclick={() => (showSettings = false)} class="btn btn-sm">Cancel</button>
					</div>
				</form>
			</div>
		{/if}

		<!-- Tasks Panel -->
		{#if showTasks}
			<div class="border-b border-base-300 bg-base-100 p-4 max-h-64 overflow-y-auto">
				<div class="flex items-center justify-between mb-2">
					<h3 class="font-semibold text-sm">Open Tasks</h3>
				</div>
				{#if tasks.length === 0}
					<div class="text-sm text-base-content/40 italic">No open tasks.</div>
				{/if}
				{#each tasks as task (task.id)}
					<div class="flex items-start gap-2 py-1">
						<input
							type="checkbox"
							class="checkbox checkbox-xs mt-0.5"
							onchange={() => toggleTask(task.id)}
						/>
						<span class="text-sm flex-1">{task.content}</span>
						{#if task.chapter_id}
							<span class="badge badge-xs badge-ghost">Ch</span>
						{/if}
						{#if task.source === 'ai'}
							<span class="badge badge-xs badge-info">ai</span>
						{/if}
					</div>
				{/each}
				<form onsubmit={(e) => { e.preventDefault(); addTask(e); }} class="mt-2 flex gap-1">
					<input
						type="text"
						name="content"
						placeholder="Add a task..."
						class="input input-xs input-bordered flex-1"
					/>
					<button type="submit" class="btn btn-xs btn-primary">+</button>
				</form>
			</div>
		{/if}

		<!-- Previous Session Summary -->
		{#if previousSessionSummary && messages.length === 0}
			<div class="border-b border-base-300 bg-base-100/50 p-3">
				<p class="text-xs font-semibold text-base-content/60 mb-1">Last session:</p>
				<p class="text-xs text-base-content/50 line-clamp-3">{previousSessionSummary}</p>
			</div>
		{/if}

		<!-- Chat Messages -->
		<div class="flex-1 overflow-y-auto p-4 space-y-4" bind:this={chatContainer}>
			{#if messages.length === 0}
				<div class="flex flex-col items-center justify-center flex-1 text-base-content/40">
					<p class="text-lg">Ready when you are.</p>
					<button
						type="button"
						onclick={() => { voiceOn = !voiceOn; if (!voiceOn) muted = false; }}
						class="btn btn-circle w-24 h-24 mt-6 mb-4 transition-all {voiceOn && !muted ? 'btn-success voice-active' : voiceOn && muted ? 'btn-warning voice-muted' : 'btn-neutral'}"
					>
						<svg xmlns="http://www.w3.org/2000/svg" class="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-14 0m7 7v4m-4 0h8M12 1a3 3 0 00-3 3v7a3 3 0 006 0V4a3 3 0 00-3-3z" />
						</svg>
					</button>
					<p class="text-sm">or type below</p>
				</div>
			{/if}
			{#each messages as msg, i (i)}
				{#if msg.role === 'action'}
					<div class="text-xs text-base-content/40 text-center italic my-1">{msg.content}</div>
				{:else}
					<div class="chat chat-start">
						<div class="chat-header text-xs text-base-content/40">
							{msg.role === 'user' ? currentUser : 'Publisher'}
						</div>
						<div class="chat-bubble {msg.role === 'user' ? 'chat-bubble-primary' : ''}">
							{msg.content}
						</div>
					</div>
				{/if}
			{/each}
			{#if aiLoading}
				<div class="chat chat-start">
					<div class="chat-header text-xs text-base-content/40">Publisher</div>
					<div class="chat-bubble">
						<span class="loading loading-dots loading-sm"></span>
					</div>
				</div>
				<div class="flex justify-center">
					<button onclick={stopAI} class="btn btn-ghost btn-xs text-error">
						<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
						Stop
					</button>
				</div>
			{/if}
		</div>

		<!-- Input Bar -->
		<div class="border-t border-base-300 p-3">
			<form onsubmit={handleSend} class="flex items-center gap-2">
				<!-- Voice Toggle -->
				<button
					type="button"
					onclick={() => { voiceOn = !voiceOn; if (!voiceOn) muted = false; }}
					class="btn btn-circle btn-lg transition-all {voiceOn && !muted ? 'btn-success voice-active' : voiceOn && muted ? 'btn-warning voice-muted' : 'btn-neutral'}"
					title={voiceOn ? 'Voice On' : 'Voice Off'}
				>
					<svg xmlns="http://www.w3.org/2000/svg" class="h-7 w-7" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
					</svg>
				</button>

				<!-- Mute -->
				{#if voiceOn}
					<button
						type="button"
						onclick={() => { muted = !muted; }}
						class="btn btn-circle btn-sm {muted ? 'btn-warning' : 'btn-ghost'}"
						title={muted ? 'Resume' : 'Pause'}
					>
						{#if muted}
							<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
								<path d="M8 5v14l11-7z" />
							</svg>
						{:else}
							<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
								<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
							</svg>
						{/if}
					</button>
				{/if}

				<!-- Turn Indicator -->
				{#if aiSpeaking}
					<span class="text-xs text-info font-medium flex items-center gap-1">
						<span class="loading loading-ring loading-xs"></span>
						Speaking...
					</span>
				{:else if aiLoading}
					<span class="text-xs text-base-content/50 font-medium flex items-center gap-1">
						<span class="loading loading-dots loading-xs"></span>
						Thinking...
					</span>
				{:else if voiceOn && !muted}
					<span class="text-xs text-success font-medium flex items-center gap-1">
						<span class="inline-block w-2 h-2 rounded-full bg-success animate-pulse"></span>
						Your turn
					</span>
				{:else if voiceOn && muted}
					<span class="text-xs text-warning font-medium">Paused</span>
				{/if}

				<!-- Text Input -->
				<input
					type="text"
					bind:value={inputText}
					placeholder={aiSpeaking ? 'AI is speaking...' : aiLoading ? 'AI is thinking...' : voiceOn && !muted ? 'Listening... (your turn)' : voiceOn && muted ? 'Paused' : 'Type a message...'}
					class="input input-bordered input-sm flex-1"
					autocomplete="off"
				/>
				<button type="submit" class="btn btn-primary btn-sm">Send</button>
			</form>
		</div>
	</div>

	<!-- MIDDLE: Chapters Nav -->
	<div class="w-[220px] flex flex-col border-r border-base-300 bg-base-100">
		<div class="p-3 border-b border-base-300 flex items-center justify-between">
			<h3 class="font-semibold text-sm">Chapters</h3>
			<div class="flex items-center gap-1">
				<select bind:value={downloadFormat} class="select select-xs w-14 min-h-0 h-6 text-xs">
					<option value="pdf">PDF</option>
					<option value="md">MD</option>
				</select>
				<button onclick={downloadBook} class="btn btn-ghost btn-xs" title="Download book">
					<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
					</svg>
				</button>
			</div>
		</div>
		<div class="flex-1 overflow-y-auto">
			{#each chapters as chapter (chapter.id)}
				<button
					onclick={() => selectChapter(chapter.id)}
					class="w-full text-left px-3 py-2 hover:bg-base-200 transition-colors {chapter.id === currentChapter.id ? 'bg-primary/10 border-l-2 border-primary' : 'border-l-2 border-transparent'}"
				>
					<div class="text-sm font-medium">{chapter.position}. {chapter.title}</div>
					{#if chapter.outline}
						<div class="text-xs text-base-content/40 truncate mt-0.5">{chapter.outline}</div>
					{/if}
				</button>
			{/each}
		</div>
		<div class="p-2 border-t border-base-300">
			<form onsubmit={(e) => { e.preventDefault(); addChapter(e); }} class="flex gap-1">
				<input
					type="text"
					name="title"
					placeholder="New chapter..."
					class="input input-xs input-bordered flex-1 min-w-0"
				/>
				<button type="submit" class="btn btn-xs btn-primary">+</button>
			</form>
		</div>
	</div>

	<!-- RIGHT: Manuscript -->
	<main class="flex-1 flex flex-col min-w-0">
		<!-- Manuscript Content -->
		<div class="flex-1 overflow-y-auto p-6" bind:this={manuscriptContainer}>
			<div class="max-w-3xl mx-auto">
				<h2 class="text-2xl font-bold mb-4">{currentChapter.title}</h2>

				<!-- Chapter Outline -->
				<div class="mb-6">
					{#if editingOutline}
						<form onsubmit={(e) => { e.preventDefault(); saveOutline(e); }} class="bg-base-200 rounded-lg p-3">
							<label class="label text-xs font-semibold pb-1" for="outline">Chapter Outline</label>
							<textarea
								id="outline"
								name="outline"
								class="textarea textarea-bordered textarea-sm w-full min-h-20"
								placeholder="Plan this chapter..."
							>{currentChapter.outline ?? ''}</textarea>
							<div class="flex gap-2 mt-2">
								<button type="submit" class="btn btn-xs btn-primary">Save</button>
								<button type="button" onclick={() => (editingOutline = false)} class="btn btn-xs">Cancel</button>
							</div>
						</form>
					{:else}
						<button
							class="bg-base-200/50 rounded-lg p-3 cursor-pointer hover:bg-base-200 transition-colors w-full text-left"
							onclick={() => (editingOutline = true)}
						>
							{#if currentChapter.outline}
								<p class="text-xs font-semibold text-base-content/60 mb-1">Outline</p>
								<p class="text-sm text-base-content/70 whitespace-pre-wrap">{currentChapter.outline}</p>
							{:else}
								<p class="text-xs text-base-content/30 italic">Click to add chapter outline...</p>
							{/if}
						</button>
					{/if}
				</div>

				{#if paragraphs.length === 0}
					<div class="text-base-content/40 italic">
						No content yet. Start talking and content will appear here.
					</div>
				{/if}

				{#each paragraphs as para (para.id)}
					<div id="paragraph-{para.id}" class="flex gap-4 mb-4 group {flashParagraphId === para.id ? 'yfe' : ''}">
						<button
							class="w-8 text-right text-sm cursor-pointer select-none shrink-0 pt-1 {selectedParagraph === para.id ? 'text-primary font-bold' : 'text-base-content/30 group-hover:text-base-content/60'}"
							onclick={() => (selectedParagraph = para.id)}
						>
							{para.position}
						</button>
						{#if editingParagraph === para.id}
							<form onsubmit={(e) => handleParagraphSave(e, para.id)} class="flex-1">
								<textarea
									name="content"
									class="textarea textarea-bordered w-full min-h-24"
								>{para.content}</textarea>
								<div class="flex gap-2 mt-1">
									<button type="submit" class="btn btn-sm btn-primary">Save</button>
									<button type="button" onclick={() => (editingParagraph = null)} class="btn btn-sm">Cancel</button>
								</div>
							</form>
						{:else if para.content.startsWith('[IMAGE:')}
							<button
								class="flex-1 cursor-pointer hover:opacity-80 text-left"
								onclick={() => (editingParagraph = para.id)}
							>
								<div class="border-2 border-dashed border-base-content/20 rounded-lg p-4 flex items-center gap-3 bg-base-200/50">
									<svg xmlns="http://www.w3.org/2000/svg" class="h-8 w-8 text-base-content/30 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
									</svg>
									<span class="text-sm text-base-content/50 italic">{para.content.replace(/^\[IMAGE:\s*/, '').replace(/\]$/, '')}</span>
								</div>
							</button>
						{:else}
							<button
								class="flex-1 leading-relaxed cursor-pointer hover:bg-base-200 rounded p-1 -m-1 text-left"
								onclick={() => (editingParagraph = para.id)}
							>
								{para.content}
							</button>
						{/if}
					</div>
				{/each}
			</div>
		</div>
	</main>
</div>
{/if}
