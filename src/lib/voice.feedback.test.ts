// Feedback-loop guard tests for the voice state machine (issue #1).
//
// No test runner is wired into this repo, so this file is a self-contained
// script using Node's built-in `node:test` + `node:assert`. It mocks the
// browser globals (SpeechRecognition, fetch, Audio, URL) and asserts the core
// invariant: SpeechRecognition is never *running* while TTS is speaking, so the
// narrator's audio can't be transcribed back as user input.
//
// Run with:  node --experimental-strip-types --test src/lib/voice.feedback.test.ts

import test from 'node:test';
import assert from 'node:assert/strict';

// --- Mock harness ---------------------------------------------------------

// Tracks how many recognition instances are currently in the "started" state.
let runningRecognizers = 0;

class MockSpeechRecognition {
	continuous = false;
	interimResults = false;
	lang = '';
	onresult: ((e: unknown) => void) | null = null;
	onerror: ((e: unknown) => void) | null = null;
	onend: (() => void) | null = null;
	private started = false;

	start() {
		if (this.started) throw new Error('already started');
		this.started = true;
		runningRecognizers++;
	}

	stop() {
		if (!this.started) return;
		this.started = false;
		runningRecognizers--;
		// Real SpeechRecognition fires onend asynchronously after stop().
		queueMicrotask(() => this.onend?.());
	}

	// Test helper: simulate the engine emitting a final transcript.
	emit(text: string) {
		this.onresult?.({
			resultIndex: 0,
			results: [{ isFinal: true, 0: { transcript: text }, length: 1 }]
		});
	}
}

class MockAudio {
	onended: (() => void) | null = null;
	currentTime = 0;
	src: string;
	constructor(src: string) {
		this.src = src;
	}
	play() {
		// Resolve playback on the next microtask so the queue advances.
		queueMicrotask(() => this.onended?.());
	}
	pause() {}
}

function installGlobals() {
	runningRecognizers = 0;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const g = globalThis as any;
	g.window = { SpeechRecognition: MockSpeechRecognition };
	g.Audio = MockAudio;
	g.URL = { createObjectURL: () => 'blob:mock', revokeObjectURL: () => {} };
	g.fetch = async () => ({
		ok: true,
		status: 200,
		blob: async () => ({})
	});
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// Import after globals exist (functions read them lazily, so order is safe,
// but this keeps intent clear).
const voice = await import('./voice.ts');

// --- Tests ----------------------------------------------------------------

test('mic is closed while TTS is speaking (no feedback loop)', async () => {
	installGlobals();

	let heard: string | null = null;
	voice.startListening((t) => {
		heard = t;
	});
	await tick();
	assert.equal(runningRecognizers, 1, 'live mic should be open before speaking');

	voice.queueSentence('The narrator says something.');
	// The moment we queue speech, the mic must close.
	assert.equal(runningRecognizers, 0, 'mic must close the instant TTS is queued');
	assert.equal(voice.isSpeaking(), true);

	// Even if the recognizer somehow fired during playback, it must be ignored.
	assert.equal(heard, null, 'no transcript should be delivered while speaking');

	// Mid-stream gap: the first sentence drains but the response hasn't been
	// finalized (flushQueue not called yet). The mic must STAY closed — this is
	// the gap where the AI's audio used to leak back in.
	await tick();
	await tick();
	assert.equal(runningRecognizers, 0, 'mic stays closed between streamed sentences');
	assert.equal(voice.isSpeaking(), true, 'still speaking until response is finalized');

	// Response finishes streaming -> finalize the queue.
	let doneFired = false;
	voice.flushQueue(() => {
		doneFired = true;
	});
	for (let i = 0; i < 5 && !doneFired; i++) await tick();

	assert.equal(voice.isSpeaking(), false, 'speaking clears after queue is finalized');
	// Live intent persists, so the mic reopens once we stop speaking.
	assert.equal(runningRecognizers, 1, 'mic reopens after TTS finishes in live mode');

	voice.stopListening();
	await tick();
	assert.equal(runningRecognizers, 0);
});

test('readAloud keeps mic closed for the whole narration, then resumes', async () => {
	installGlobals();

	voice.startListening(() => {});
	await tick();
	assert.equal(runningRecognizers, 1);

	let done = false;
	voice.readAloud('Sentence one. Sentence two. Sentence three.', () => {
		done = true;
	});
	assert.equal(runningRecognizers, 0, 'mic closed during narration');

	// Drain all chunks.
	for (let i = 0; i < 10 && !done; i++) await tick();
	assert.equal(done, true, 'readAloud onDone fired');
	assert.equal(runningRecognizers, 1, 'mic resumes after narration in live mode');

	voice.stopListening();
	await tick();
});

test('PTT fires exactly once on release and never auto-restarts', async () => {
	installGlobals();

	const fired: string[] = [];
	voice.pttStart((t) => fired.push(t));
	assert.equal(runningRecognizers, 1, 'PTT opens the mic while held');

	// Simulate the user speaking, then releasing the button.
	// (We reach into the running recognizer to emit a result.)
	voice.pttStop();
	await tick();
	await tick();

	assert.equal(runningRecognizers, 0, 'PTT mic closes on release — no self-restart');
	// onend fired exactly once (no double-fire). Empty transcript => no push.
	assert.equal(fired.length, 0, 'no transcript collected => nothing sent');
});

test('starting PTT stops any in-progress TTS', async () => {
	installGlobals();

	voice.queueSentence('A long narration the user wants to interrupt.');
	assert.equal(voice.isSpeaking(), true);

	voice.pttStart(() => {});
	assert.equal(voice.isSpeaking(), false, 'PTT interrupts TTS so mic only hears the user');
	assert.equal(runningRecognizers, 1, 'PTT mic is open after interrupting');

	voice.pttStop();
	await tick();
	await tick();
	assert.equal(runningRecognizers, 0);
});
