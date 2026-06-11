// Research / fact-check tool.
//
// Backs the `research` tool the writing agent can call to verify claims against
// REAL web sources (issue #6). The book ("The Physics of Healing") is
// claims-dense, so anti-fabrication is load-bearing:
//
//   - Sources here come ONLY from the search provider's response. We never
//     synthesize, guess, or pad citations. If the provider returns nothing
//     usable, we say so plainly and let the model report that the evidence is
//     thin rather than inventing support.
//   - The raw results are handed back to the model as a tool result; the model
//     synthesizes for the author. We do not fabricate a "summary" here.
//
// Provider: Brave Search API (issue named Perplexity OR Brave Search + Haiku
// summarization). Brave keeps the search and the summarization concerns
// separate, which is the safer choice for an anti-fabrication tool: Brave only
// ever returns real indexed pages, and the model does the synthesis with the
// real results in front of it.

const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';

/** A single real source returned by the search provider. */
export interface ResearchSource {
	title: string;
	url: string;
	/** Provider-supplied snippet/description. Never author-generated. */
	snippet: string;
	/** Age/published string when the provider supplies one (e.g. "2 years ago"). */
	age?: string;
}

export interface ResearchResult {
	query: string;
	sources: ResearchSource[];
	/**
	 * True when the search ran but returned no usable sources. The model MUST
	 * tell the author the evidence is thin in this case — it must not invent
	 * support.
	 */
	thin: boolean;
	/** Set when the search could not run at all (missing key, provider error). */
	error?: string;
}

function stripHtml(s: string): string {
	// Brave wraps matched terms in <strong> tags and may include entities.
	return s
		.replace(/<[^>]+>/g, '')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.trim();
}

/**
 * Run a web search for `query` and return REAL sources only.
 *
 * Never throws for an empty/failed search — returns a `ResearchResult` whose
 * `thin` or `error` field tells the caller the truth, so the model can be
 * honest with the author instead of fabricating.
 */
export async function research(
	query: string,
	apiKey: string | undefined,
	maxSources = 5
): Promise<ResearchResult> {
	const trimmed = query.trim();
	if (!trimmed) {
		return { query, sources: [], thin: true, error: 'Empty query.' };
	}

	if (!apiKey) {
		return {
			query: trimmed,
			sources: [],
			thin: true,
			error: 'No search API key configured (BRAVE_SEARCH_API_KEY).'
		};
	}

	const url = new URL(BRAVE_SEARCH_URL);
	url.searchParams.set('q', trimmed);
	url.searchParams.set('count', String(Math.min(Math.max(maxSources, 1), 20)));
	// Drop the heavier result types we don't use — we only synthesize from web pages.
	url.searchParams.set('result_filter', 'web');

	let response: Response;
	try {
		response = await fetch(url, {
			headers: {
				Accept: 'application/json',
				'Accept-Encoding': 'gzip',
				'X-Subscription-Token': apiKey
			}
		});
	} catch (err) {
		return {
			query: trimmed,
			sources: [],
			thin: true,
			error: `Search request failed: ${err instanceof Error ? err.message : 'network error'}`
		};
	}

	if (!response.ok) {
		const body = await response.text().catch(() => '');
		return {
			query: trimmed,
			sources: [],
			thin: true,
			error: `Search provider returned ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`
		};
	}

	let data: any;
	try {
		data = await response.json();
	} catch {
		return { query: trimmed, sources: [], thin: true, error: 'Malformed search response.' };
	}

	const webResults: any[] = data?.web?.results ?? [];
	const sources: ResearchSource[] = webResults
		.filter((r) => r?.url && r?.title)
		.slice(0, maxSources)
		.map((r) => ({
			title: stripHtml(String(r.title)),
			url: String(r.url),
			snippet: stripHtml(String(r.description ?? '')),
			age: r.age ? String(r.age) : undefined
		}));

	return { query: trimmed, sources, thin: sources.length === 0 };
}

/**
 * Format a ResearchResult as a tool-result string for the model.
 *
 * This is the ONLY thing the model sees about the search. It deliberately:
 *   - presents real sources verbatim (title, URL, snippet) so the model can
 *     cite accurately, and
 *   - instructs the model, when evidence is thin or the search failed, to tell
 *     the author the truth rather than fabricating a study or citation.
 *
 * The author never sees this text — only the model's synthesized reply.
 */
export function formatResearchResult(result: ResearchResult): string {
	if (result.error && result.sources.length === 0) {
		return [
			`Research for "${result.query}" could not be completed: ${result.error}`,
			'',
			'Tell the author honestly that you could not verify this right now. Do NOT invent sources, studies, or statistics to fill the gap.'
		].join('\n');
	}

	if (result.thin || result.sources.length === 0) {
		return [
			`Research for "${result.query}" returned no usable sources.`,
			'',
			'The evidence is thin. Tell the author plainly that you could not find solid sources for this claim — do NOT fabricate a study, citation, or statistic. Suggest the claim be softened or flagged for follow-up.'
		].join('\n');
	}

	const lines = [
		`Web search results for "${result.query}" (${result.sources.length} real source${result.sources.length === 1 ? '' : 's'}).`,
		'',
		'Synthesize an answer for the author from ONLY these sources. Use them to verify or correct the claim. If they do not actually support the claim, say so. Do NOT invent facts, studies, or numbers beyond what is below. You may mention a source by name where it helps the author trust the answer.',
		''
	];

	result.sources.forEach((s, i) => {
		lines.push(`[${i + 1}] ${s.title}${s.age ? ` (${s.age})` : ''}`);
		lines.push(`    ${s.url}`);
		if (s.snippet) lines.push(`    ${s.snippet}`);
		lines.push('');
	});

	return lines.join('\n').trimEnd();
}
