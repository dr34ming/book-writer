const ELEVENLABS_URL = 'https://api.elevenlabs.io/v1/text-to-speech';
const VOICE_EDITOR = '21m00Tcm4TlvDq8ikWAM'; // Rachel (female, editor)
const VOICE_NARRATOR = 'pNInz6obpgDQGcFmaJgB'; // Adam (male, narrator)

export async function synthesize(text: string, apiKey: string, voice: 'editor' | 'narrator' = 'editor'): Promise<Response> {
	const voiceId = voice === 'narrator' ? VOICE_NARRATOR : VOICE_EDITOR;
	const response = await fetch(`${ELEVENLABS_URL}/${voiceId}`, {
		method: 'POST',
		headers: {
			'xi-api-key': apiKey,
			'Content-Type': 'application/json',
			Accept: 'audio/mpeg'
		},
		body: JSON.stringify({
			text,
			model_id: 'eleven_monolingual_v1',
			voice_settings: {
				stability: 0.6,
				similarity_boost: 0.75
			}
		})
	});

	if (!response.ok) {
		const body = await response.text();
		throw new Error(`ElevenLabs ${response.status}: ${body}`);
	}

	return new Response(response.body, {
		headers: { 'Content-Type': 'audio/mpeg' }
	});
}
