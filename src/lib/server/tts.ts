const ELEVENLABS_URL = 'https://api.elevenlabs.io/v1/text-to-speech';
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // Rachel

export async function synthesize(text: string, apiKey: string): Promise<Response> {
	const response = await fetch(`${ELEVENLABS_URL}/${DEFAULT_VOICE_ID}`, {
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
