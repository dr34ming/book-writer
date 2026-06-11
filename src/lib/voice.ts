type SpeechCallback = (text: string) => void;

type Voice = 'editor' | 'narrator';

// ---------------------------------------------------------------------------
// Feedback-loop guard
//
// The mic and the TTS output must never be live at the same time, or the
// narrator's voice gets transcribed and re-sent as user input (issue #1).
//
// Invariant: while `speaking` is true, NO SpeechRecognition instance may be
// running. Live-mode recognition is gated on `liveActive` (the user's intent
// to keep listening) AND `!speaking`. PTT recognition refuses to start while
// speaking. This module owns the invariant so callers can't accidentally
// resurrect the mic mid-playback.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let recognition: any = null;
let currentAudio: HTMLAudioElement | null = null;

// Live-mode intent: user wants the mic to keep listening whenever we're not
// speaking. Auto-restart (onend/onerror) only fires while this is true.
let liveActive = false;
let liveCallback: SpeechCallback | null = null;

// True from the moment TTS is queued until the queue fully drains. Recognition
// is forbidden while this is set.
let speaking = false;

// Sentence queue for streaming TTS
let sentenceQueue: Array<{ text: string; voice: Voice }> = [];
let queuePlaying = false;
let queueStopped = false;
let queueDoneCallback: (() => void) | null = null;
let queueFinalized = false; // true once flushQueue is called (no more sentences coming)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getRecognitionCtor(): any {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const w = window as any;
	return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

// ---------------------------------------------------------------------------
// Live (continuous) listening
// ---------------------------------------------------------------------------

export function startListening(onResult: SpeechCallback) {
	liveActive = true;
	liveCallback = onResult;

	// Never open the mic while TTS is playing — that's the feedback loop. When
	// playback finishes, the queue drain will call resumeLiveListening().
	if (speaking) return;
	if (recognition) return;

	const SpeechRecognitionCtor = getRecognitionCtor();
	if (!SpeechRecognitionCtor) {
		console.warn('Speech recognition not supported');
		return;
	}

	const rec = new SpeechRecognitionCtor();
	rec.continuous = true;
	rec.interimResults = false;
	rec.lang = 'en-US';

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	rec.onresult = (event: any) => {
		// Drop anything heard while we're (or were) speaking — defense in depth
		// against the mic catching the tail of TTS audio.
		if (speaking) return;
		const last = event.results[event.results.length - 1];
		if (last.isFinal) {
			const text = last[0].transcript.trim();
			if (text && liveCallback) liveCallback(text);
		}
	};

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	rec.onerror = (event: any) => {
		if (event.error !== 'no-speech' && event.error !== 'aborted') {
			console.error('Speech recognition error:', event.error);
		}
	};

	rec.onend = () => {
		// Only this instance owns auto-restart, and only while the user still
		// wants live listening and we're not speaking.
		if (recognition === rec) recognition = null;
		if (liveActive && !speaking) {
			// Re-open after a beat to avoid a tight error/restart loop.
			setTimeout(() => {
				if (liveActive && !speaking && !recognition && liveCallback) {
					startListening(liveCallback);
				}
			}, 250);
		}
	};

	recognition = rec;
	try {
		rec.start();
	} catch {
		/* already started */
	}
}

// Stop the live recognizer but keep the user's intent (used while speaking).
function suspendLiveRecognizer() {
	if (recognition) {
		const rec = recognition;
		recognition = null;
		rec.onend = null; // prevent its onend from auto-restarting
		try {
			rec.stop();
		} catch {
			/* already stopped */
		}
	}
}

// Re-open the mic after speaking, if Live mode is still active.
function resumeLiveListening() {
	if (liveActive && !speaking && !recognition && liveCallback) {
		startListening(liveCallback);
	}
}

// pauseListening: stop the recognizer and clear live intent so it won't
// auto-restart. Used when leaving Live mode.
export function pauseListening() {
	liveActive = false;
	liveCallback = null;
	suspendLiveRecognizer();
}

export function stopListening() {
	pauseListening();
}

// ---------------------------------------------------------------------------
// TTS playback
// ---------------------------------------------------------------------------

// Play a single sentence via TTS
async function playSentence(text: string, voice: Voice = 'editor'): Promise<void> {
	try {
		const resp = await fetch('/api/tts', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text, voice })
		});

		if (!resp.ok) {
			console.error('TTS error:', resp.status);
			return;
		}

		const blob = await resp.blob();
		const url = URL.createObjectURL(blob);
		currentAudio = new Audio(url);

		return new Promise<void>((resolve) => {
			currentAudio!.onended = () => {
				URL.revokeObjectURL(url);
				currentAudio = null;
				resolve();
			};
			currentAudio!.play();
		});
	} catch (err) {
		console.error('TTS fetch error:', err);
	}
}

// Process the sentence queue sequentially
async function processQueue() {
	if (queuePlaying) return;
	queuePlaying = true;

	// Entering playback: close the mic so it can't hear us.
	speaking = true;
	suspendLiveRecognizer();

	while (sentenceQueue.length > 0) {
		if (queueStopped) break;
		const item = sentenceQueue.shift()!;
		await playSentence(item.text, item.voice);
		if (queueStopped) break;
	}

	queuePlaying = false;

	if (queueStopped) {
		// stopSpeaking() owns teardown in this case.
		return;
	}

	if (queueFinalized && sentenceQueue.length === 0) {
		// Finalized and drained: fire the done callback and resume listening.
		speaking = false;
		const cb = queueDoneCallback;
		queueDoneCallback = null;
		queueFinalized = false;
		if (cb) cb();
		resumeLiveListening();
		return;
	}

	// Drained but not finalized — more streamed sentences are still on the way
	// (the response hasn't called flushQueue yet). Stay in the speaking state
	// and keep the mic closed: reopening it for the gap between streamed
	// sentences is exactly how the AI's own audio leaked back in (issue #1).
	// flushQueue() will clear `speaking` and resume listening when the full
	// response is done. stopSpeaking()/pttStart() can also break us out.
}

// Queue a sentence for TTS — starts playing immediately if idle
export function queueSentence(text: string, voice: Voice = 'editor') {
	if (!text.trim()) return;
	speaking = true;
	suspendLiveRecognizer();
	sentenceQueue.push({ text: text.trim(), voice });
	processQueue();
}

// Signal that no more sentences are coming — onDone fires after last one plays
export function flushQueue(onDone?: () => void) {
	queueDoneCallback = onDone ?? null;
	queueFinalized = true;

	if (sentenceQueue.length === 0 && !queuePlaying) {
		// Nothing left to play
		queueFinalized = false;
		speaking = false;
		const cb = queueDoneCallback;
		queueDoneCallback = null;
		if (cb) cb();
		resumeLiveListening();
		return;
	}

	// If not currently playing, kick it off so it drains and fires callback
	if (!queuePlaying) {
		processQueue();
	}
	// If already playing, the loop will pick up queueFinalized when it drains
}

export function isSpeaking(): boolean {
	return speaking || queuePlaying || currentAudio !== null;
}

// Legacy: speak full text at once
export async function speak(text: string): Promise<void> {
	if (!text) return;
	speaking = true;
	suspendLiveRecognizer();
	await playSentence(text);
	speaking = false;
	resumeLiveListening();
}

// Read content aloud with the narrator voice. Splits into chunks for long text.
export function readAloud(text: string, onDone?: () => void) {
	if (!text.trim()) return;
	stopSpeaking();

	// Split into ~600 char chunks at sentence boundaries
	const chunks: string[] = [];
	let remaining = text.trim();
	while (remaining.length > 0) {
		if (remaining.length <= 600) {
			chunks.push(remaining);
			break;
		}
		// Find sentence break near 600 chars
		const slice = remaining.slice(0, 600);
		const breakIdx = Math.max(
			slice.lastIndexOf('. '),
			slice.lastIndexOf('! '),
			slice.lastIndexOf('? ')
		);
		if (breakIdx > 200) {
			chunks.push(remaining.slice(0, breakIdx + 1));
			remaining = remaining.slice(breakIdx + 2);
		} else {
			chunks.push(slice);
			remaining = remaining.slice(600);
		}
	}

	for (const chunk of chunks) {
		queueSentence(chunk, 'narrator');
	}
	flushQueue(onDone);
}

export function stopSpeaking() {
	queueStopped = true;
	queueFinalized = false;
	queueDoneCallback = null;
	sentenceQueue.length = 0;
	if (currentAudio) {
		currentAudio.pause();
		currentAudio.currentTime = 0;
		currentAudio = null;
	}
	queuePlaying = false;
	speaking = false;
	// Reset for next time
	queueStopped = false;
	resumeLiveListening();
}

// ---------------------------------------------------------------------------
// Push-to-talk (one-shot, gated on the held key/button)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pttRecognition: any = null;
let pttFired = false;

export function pttStart(onResult: SpeechCallback) {
	if (pttRecognition) return;

	const SpeechRecognitionCtor = getRecognitionCtor();
	if (!SpeechRecognitionCtor) {
		console.warn('Speech recognition not supported');
		return;
	}

	// User is talking — kill any TTS so the mic only hears the user, and clear
	// the speaking guard so the next live resume isn't blocked.
	stopSpeaking();
	speaking = false;

	pttFired = false;
	let collected = '';
	const rec = new SpeechRecognitionCtor();
	rec.continuous = true;
	rec.interimResults = false;
	rec.lang = 'en-US';

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	rec.onresult = (event: any) => {
		for (let i = event.resultIndex; i < event.results.length; i++) {
			if (event.results[i].isFinal) {
				collected += ' ' + event.results[i][0].transcript.trim();
			}
		}
	};

	rec.onerror = () => {};

	rec.onend = () => {
		// PTT never auto-restarts. It fires once, on release.
		if (pttRecognition === rec) pttRecognition = null;
		if (pttFired) return;
		pttFired = true;
		const text = collected.trim();
		if (text) onResult(text);
	};

	pttRecognition = rec;
	try {
		rec.start();
	} catch {
		/* */
	}
}

export function pttStop() {
	if (pttRecognition) {
		try {
			pttRecognition.stop();
		} catch {
			/* */
		}
	}
}
