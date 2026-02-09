type SpeechCallback = (text: string) => void;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let recognition: any = null;
let currentAudio: HTMLAudioElement | null = null;

// Sentence queue for streaming TTS
let sentenceQueue: Array<{ text: string; voice: Voice }> = [];
let queuePlaying = false;
let queueStopped = false;
let queueDoneCallback: (() => void) | null = null;
let queueFinalized = false; // true once flushQueue is called (no more sentences coming)

export function startListening(onResult: SpeechCallback) {
	if (recognition) return;

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const w = window as any;
	const SpeechRecognitionCtor = w.SpeechRecognition ?? w.webkitSpeechRecognition;

	if (!SpeechRecognitionCtor) {
		console.warn('Speech recognition not supported');
		return;
	}

	recognition = new SpeechRecognitionCtor();
	recognition.continuous = true;
	recognition.interimResults = false;
	recognition.lang = 'en-US';

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	recognition.onresult = (event: any) => {
		const last = event.results[event.results.length - 1];
		if (last.isFinal) {
			const text = last[0].transcript.trim();
			if (text) onResult(text);
		}
	};

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	recognition.onerror = (event: any) => {
		console.error('Speech recognition error:', event.error);
		if (event.error !== 'no-speech' && event.error !== 'aborted') {
			setTimeout(() => {
				if (recognition) {
					try {
						recognition.start();
					} catch {
						/* already started */
					}
				}
			}, 1000);
		}
	};

	recognition.onend = () => {
		if (recognition) {
			try {
				recognition.start();
			} catch {
				/* already started */
			}
		}
	};

	try {
		recognition.start();
	} catch {
		/* already started */
	}
}

export function pauseListening() {
	if (recognition) {
		try {
			recognition.stop();
		} catch {
			/* already stopped */
		}
		recognition = null;
	}
}

export function stopListening() {
	pauseListening();
}

type Voice = 'editor' | 'narrator';

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
	pauseListening();

	while (sentenceQueue.length > 0) {
		if (queueStopped) break;
		const item = sentenceQueue.shift()!;
		await playSentence(item.text, item.voice);
		if (queueStopped) break;
	}

	// If queue is finalized and drained, we're done
	if (queueFinalized && sentenceQueue.length === 0 && !queueStopped) {
		queuePlaying = false;
		const cb = queueDoneCallback;
		queueDoneCallback = null;
		queueFinalized = false;
		if (cb) cb();
		return;
	}

	queuePlaying = false;
}

// Queue a sentence for TTS — starts playing immediately if idle
export function queueSentence(text: string, voice: Voice = 'editor') {
	if (!text.trim()) return;
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
		const cb = queueDoneCallback;
		queueDoneCallback = null;
		if (cb) cb();
		return;
	}

	// If not currently playing, kick it off so it drains and fires callback
	if (!queuePlaying) {
		processQueue();
	}
	// If already playing, the loop will pick up queueFinalized when it drains
}

export function isSpeaking(): boolean {
	return queuePlaying || currentAudio !== null;
}

// Legacy: speak full text at once
export async function speak(text: string): Promise<void> {
	if (!text) return;
	pauseListening();
	await playSentence(text);
}

// Read content aloud with the narrator voice. Splits into chunks for long text.
export function readAloud(text: string, onDone?: () => void) {
	if (!text.trim()) return;
	stopSpeaking();

	// Split into ~500 char chunks at sentence boundaries
	const chunks: string[] = [];
	let remaining = text.trim();
	while (remaining.length > 0) {
		if (remaining.length <= 600) {
			chunks.push(remaining);
			break;
		}
		// Find sentence break near 500 chars
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
	// Reset for next time
	queueStopped = false;
}

// PTT: one-shot recognition. Returns a stop function.
// Collects all speech while held, fires onResult with combined text on stop.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pttRecognition: any = null;

export function pttStart(onResult: SpeechCallback) {
	if (pttRecognition) return;

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const w = window as any;
	const SpeechRecognitionCtor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
	if (!SpeechRecognitionCtor) {
		console.warn('Speech recognition not supported');
		return;
	}

	stopSpeaking(); // stop any TTS when user starts talking

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
		pttRecognition = null;
		const text = collected.trim();
		if (text) onResult(text);
	};

	pttRecognition = rec;
	try { rec.start(); } catch { /* */ }
}

export function pttStop() {
	if (pttRecognition) {
		try { pttRecognition.stop(); } catch { /* */ }
	}
}
