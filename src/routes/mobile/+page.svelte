<script lang="ts">
	import type { PageData } from './$types';
	import type { AIAction } from '$lib/types';
	import { executeActions, summarizeAction, type PageState } from '$lib/actions';
	import { startListening, pauseListening, stopListening, stopSpeaking, queueSentence, flushQueue, pttStart, pttStop } from '$lib/voice';

	let { data }: { data: PageData } = $props();

	let loginInput = $state('');

	async function login(username: string) {
		await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username }) });
		window.location.reload();
	}

	const loggedIn = data.loggedIn;
	const d = loggedIn ? data : null;
	let book = $state(d?.book ?? { id: 0, title: '', description: null, user_id: 0 });
	let chapters = $state(d?.chapters ?? []);
	let session = $state(d?.session ?? { id: 0, book_id: 0, mode: 'conversation', summary: null, transcript: null });
	let messages = $state<{ role: string; content: string }[]>([]);
	let userInstructions = $state(d?.userInstructions ?? '');
	let previousSessionSummary = $state(d?.previousSessionSummary ?? null);
	let currentUser = $state(data.user?.username ?? '');

	// Voice state
	let voiceMode = $state<'off' | 'ptt' | 'live'>('ptt'); // default to PTT on mobile
	let pttActive = $state(false);
	let aiLoading = $state(false);
	let aiSpeaking = $state(false);
	let abortController: AbortController | null = null;

	let inputText = $state('');
	let chatContainer: HTMLDivElement;

	// Dummy state for PageState compatibility (mobile doesn't show manuscript)
	let currentChapter = $state<any>({ id: 0, book_id: 0, title: '', position: 1, outline: null, paragraphs: [] });
	let paragraphs = $state<any[]>([]);
	let tasks = $state<any[]>([]);
	let selectedParagraph = $state<number | null>(null);
	let editingParagraph = $state<number | null>(null);
	let wordCount = $state(0);

	function stopAI() {
		if (abortController) { abortController.abort(); abortController = null; }
		stopSpeaking();
		aiLoading = false;
		aiSpeaking = false;
		if (voiceMode === 'live') startListening((text) => sendMessage(text));
	}

	// Voice effects
	$effect(() => {
		if (voiceMode === 'live') {
			startListening((text) => sendMessage(text));
		} else {
			pauseListening();
		}
	});

	$effect(() => {
		if (voiceMode === 'off') { stopListening(); stopSpeaking(); }
	});

	// Auto-scroll
	$effect(() => {
		if (messages.length > 0 && chatContainer) {
			requestAnimationFrame(() => { chatContainer.scrollTop = chatContainer.scrollHeight; });
		}
	});

	function setVoiceMode(mode: 'off' | 'ptt' | 'live') {
		if (pttActive) { pttActive = false; pttStop(); }
		voiceMode = mode;
	}

	const COMPACT_THRESHOLD = 20;

	async function sendMessage(text: string) {
		if (!text.trim()) return;
		const userMsg = { role: 'user', content: text.trim() };
		messages = [...messages, userMsg];
		inputText = '';
		aiLoading = true;

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
				messages = [...messages, { role: 'assistant', content: `Error (${resp.status}).` }];
				aiLoading = false;
				return;
			}

			const reader = resp.body!.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			let fullContent = '';
			let assistantAdded = false;
			let firstSentenceSent = false;
			let firstSentenceEnd = -1;

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
						if (parsed.type === 'token') {
							fullContent += parsed.content;
							if (!assistantAdded) {
								messages = [...messages, { role: 'assistant', content: fullContent }];
								assistantAdded = true;
							} else {
								messages = messages.map((m, i) => i === messages.length - 1 ? { ...m, content: fullContent } : m);
							}
							// TTS first sentence
							if (voiceMode !== 'off' && !firstSentenceSent) {
								const match = fullContent.match(/[.!?]\s/);
								if (match && match.index !== undefined) {
									firstSentenceEnd = match.index + 1;
									firstSentenceSent = true;
									aiSpeaking = true;
									queueSentence(fullContent.slice(0, firstSentenceEnd));
								}
							}
						} else if (parsed.type === 'actions') {
							const state = getPageState();
							const summaries = await executeActions(parsed.actions, state, (fn) => {
								const updates = fn(state);
								if (updates.chapters) chapters = updates.chapters as typeof chapters;
								if (updates.session) session = updates.session as typeof session;
								if (updates.messages) messages = updates.messages as typeof messages;
								if (updates.previousSessionSummary !== undefined) previousSessionSummary = updates.previousSessionSummary as string | null;
							});
							for (const summary of summaries) {
								messages = [...messages, { role: 'action', content: summary }];
							}
						}
					} catch { /* skip malformed */ }
				}
			}

			aiLoading = false;
			abortController = null;

			// TTS remainder
			if (voiceMode !== 'off') {
				if (firstSentenceSent && firstSentenceEnd < fullContent.length) {
					const remainder = fullContent.slice(firstSentenceEnd).trim();
					if (remainder) queueSentence(remainder);
				} else if (!firstSentenceSent && fullContent.trim()) {
					aiSpeaking = true;
					queueSentence(fullContent.trim());
				}
				flushQueue(() => {
					aiSpeaking = false;
					if (voiceMode === 'live') startListening((text) => sendMessage(text));
				});
			}

			if (messages.length >= COMPACT_THRESHOLD) compactMessages();
		} catch (err) {
			if ((err as Error).name === 'AbortError') { abortController = null; return; }
			messages = [...messages, { role: 'assistant', content: 'Something went wrong.' }];
			aiLoading = false;
			abortController = null;
		}
	}

	async function compactMessages() {
		try {
			const resp = await fetch('/api/compact', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ messages: messages.slice(0, -6).filter((m) => m.role !== 'action').map((m) => ({ role: m.role, content: m.content })) })
			});
			if (resp.ok) {
				const data = await resp.json() as any;
				messages = [{ role: 'system', content: `[Previous conversation summary]\n${data.summary}` }, ...messages.slice(-6)];
			}
		} catch { /* */ }
	}

	function getPageState(): PageState {
		return {
			chapters, currentChapter, paragraphs, tasks,
			selectedParagraph, editingParagraph, wordCount,
			session, messages, previousSessionSummary,
			bookId: book.id, bookTitle: book.title, userInstructions
		};
	}

	function handleSend(event: SubmitEvent) {
		event.preventDefault();
		sendMessage(inputText);
	}

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
			if (resp.ok) {
				const data = await resp.json() as any;
				session = data.session;
				previousSessionSummary = data.summary;
				messages = [];
			}
		} catch { /* */ }
		aiLoading = false;
	}
</script>

{#if !loggedIn}
<div class="flex items-center justify-center h-screen bg-base-200">
	<div class="card bg-base-100 shadow-xl w-80">
		<div class="card-body items-center text-center">
			<h2 class="card-title text-2xl mb-4">Book Writer</h2>
			<form onsubmit={(e) => { e.preventDefault(); if (loginInput.trim()) login(loginInput.trim()); }} class="w-full">
				<input type="text" bind:value={loginInput} placeholder="Enter your name" class="input input-bordered w-full mb-3" autofocus />
				<button type="submit" class="btn btn-primary w-full" disabled={!loginInput.trim()}>Log in</button>
			</form>
		</div>
	</div>
</div>
{:else}
<div class="flex flex-col h-screen h-[100dvh] bg-base-100">
	<!-- Top Bar -->
	<div class="flex items-center justify-between px-3 py-2 border-b border-base-300 bg-base-200 shrink-0">
		<span class="text-sm font-semibold truncate">{book.title}</span>
		<div class="flex items-center gap-1">
			{#if messages.length > 0}
				<button onclick={wrapSession} class="btn btn-ghost btn-xs" title="Wrap session">
					<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
					</svg>
				</button>
			{/if}
			<a href="/" class="btn btn-ghost btn-xs" title="Desktop view">
				<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
				</svg>
			</a>
		</div>
	</div>

	<!-- Previous Session -->
	{#if previousSessionSummary && messages.length === 0}
		<div class="border-b border-base-300 bg-base-100/50 px-4 py-2 shrink-0">
			<p class="text-xs text-base-content/50 line-clamp-2">{previousSessionSummary}</p>
		</div>
	{/if}

	<!-- Chat -->
	<div class="flex-1 overflow-y-auto px-4 py-3 space-y-3" bind:this={chatContainer}>
		{#if messages.length === 0}
			<div class="flex flex-col items-center justify-center h-full text-base-content/40">
				<p class="text-lg mb-6">Ready when you are.</p>
				<!-- Mode selector -->
				<div class="join mb-4">
					<button type="button" class="join-item btn btn-sm {voiceMode === 'off' ? 'btn-active' : ''}" onclick={() => setVoiceMode('off')}>Off</button>
					<button type="button" class="join-item btn btn-sm {voiceMode === 'ptt' ? 'btn-active btn-warning' : ''}" onclick={() => setVoiceMode('ptt')}>Push to Talk</button>
					<button type="button" class="join-item btn btn-sm {voiceMode === 'live' ? 'btn-active btn-success' : ''}" onclick={() => setVoiceMode('live')}>Live</button>
				</div>
				{#if voiceMode === 'ptt'}
					<button
						type="button"
						class="btn btn-circle w-28 h-28 transition-all ptt-touch {pttActive ? 'btn-error voice-active scale-110' : 'btn-warning'}"
						onpointerdown={() => { pttActive = true; pttStart((text) => sendMessage(text)); }}
						onpointerup={() => { pttActive = false; pttStop(); }}
						onpointerleave={() => { if (pttActive) { pttActive = false; pttStop(); } }}
					>
						<svg xmlns="http://www.w3.org/2000/svg" class="h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-14 0m7 7v4m-4 0h8M12 1a3 3 0 00-3 3v7a3 3 0 006 0V4a3 3 0 00-3-3z" />
						</svg>
					</button>
					<p class="text-sm mt-3">{pttActive ? 'Listening...' : 'Hold to talk'}</p>
				{:else if voiceMode === 'live'}
					<div class="btn btn-circle w-28 h-28 btn-success voice-active pointer-events-none">
						<svg xmlns="http://www.w3.org/2000/svg" class="h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-14 0m7 7v4m-4 0h8M12 1a3 3 0 00-3 3v7a3 3 0 006 0V4a3 3 0 00-3-3z" />
						</svg>
					</div>
					<p class="text-sm mt-3 text-success">Always listening</p>
				{:else}
					<p class="text-sm">Type below or enable voice</p>
				{/if}
			</div>
		{/if}
		{#each messages as msg, i (i)}
			{#if msg.role === 'action'}
				<div class="text-xs text-base-content/40 text-center italic my-1">{msg.content}</div>
			{:else}
				<div class="chat {msg.role === 'user' ? 'chat-end' : 'chat-start'}">
					<div class="chat-bubble {msg.role === 'user' ? 'chat-bubble-primary' : ''} text-sm">
						{msg.content}
					</div>
				</div>
			{/if}
		{/each}
		{#if aiLoading}
			<div class="chat chat-start">
				<div class="chat-bubble text-sm">
					<span class="loading loading-dots loading-sm"></span>
				</div>
			</div>
			<div class="flex justify-center">
				<button onclick={stopAI} class="btn btn-ghost btn-xs text-error">Stop</button>
			</div>
		{/if}
	</div>

	<!-- Input Bar -->
	<div class="border-t border-base-300 p-2 bg-base-200 shrink-0">
		<form onsubmit={handleSend} class="flex items-center gap-2">
			<!-- Mode selector (compact) -->
			<div class="join">
				<button type="button" class="join-item btn btn-xs {voiceMode === 'off' ? 'btn-active' : ''}" onclick={() => setVoiceMode('off')} title="Off">
					<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
					</svg>
				</button>
				<button type="button" class="join-item btn btn-xs {voiceMode === 'ptt' ? 'btn-active btn-warning' : ''}" onclick={() => setVoiceMode('ptt')} title="Push to talk">PTT</button>
				<button type="button" class="join-item btn btn-xs {voiceMode === 'live' ? 'btn-active btn-success' : ''}" onclick={() => setVoiceMode('live')} title="Live">
					<svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
					</svg>
				</button>
			</div>

			<!-- PTT hold button (inline) -->
			{#if voiceMode === 'ptt'}
				<button
					type="button"
					class="btn btn-circle btn-sm transition-all ptt-touch {pttActive ? 'btn-error voice-active' : 'btn-warning'}"
					onpointerdown={() => { pttActive = true; pttStart((text) => sendMessage(text)); }}
					onpointerup={() => { pttActive = false; pttStop(); }}
					onpointerleave={() => { if (pttActive) { pttActive = false; pttStop(); } }}
				>
					<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
					</svg>
				</button>
			{/if}

			<!-- Status -->
			{#if aiSpeaking}
				<span class="text-xs text-info flex items-center gap-1">
					<span class="loading loading-ring loading-xs"></span>
				</span>
			{:else if pttActive}
				<span class="text-xs text-error flex items-center gap-1">
					<span class="inline-block w-2 h-2 rounded-full bg-error animate-pulse"></span>
				</span>
			{:else if voiceMode === 'live' && !aiLoading}
				<span class="text-xs text-success flex items-center gap-1">
					<span class="inline-block w-2 h-2 rounded-full bg-success animate-pulse"></span>
				</span>
			{/if}

			<input
				type="text"
				bind:value={inputText}
				placeholder={aiSpeaking ? 'Speaking...' : pttActive ? 'Recording...' : voiceMode === 'live' ? 'Listening...' : 'Type a message...'}
				class="input input-bordered input-sm flex-1 min-w-0"
				autocomplete="off"
			/>
			<button type="submit" class="btn btn-primary btn-sm">
				<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
				</svg>
			</button>
		</form>
	</div>
</div>
{/if}
