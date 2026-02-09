type SpeechCallback = (text: string) => void;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let recognition: any = null;
let currentAudio: HTMLAudioElement | null = null;

// Sentence queue for streaming TTS
let sentenceQueue: string[] = [];
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

// Play a single sentence via TTS
async function playSentence(text: string): Promise<void> {
	try {
		const resp = await fetch('/api/tts', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text })
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
		const sentence = sentenceQueue.shift()!;
		await playSentence(sentence);
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
export function queueSentence(text: string) {
	if (!text.trim()) return;
	sentenceQueue.push(text.trim());
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
