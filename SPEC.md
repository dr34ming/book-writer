# Book Writer — Spec v0.2

An AI-powered interview coach that helps Jackie Patricia write her Feng Shui teaching guide.

## What It Is

A web app where Jackie can have a voice conversation with an AI that interviews her, captures her ideas, organizes them into chapters, and helps her refine the book over time. Think: a patient, warm co-author who listens, asks great questions, and keeps the manuscript organized.

The AI isn't just a transcription tool — it's Jackie's **publisher**. It wants her to succeed. It helps her understand the craft, the market, the process. It coaches her through being an author, not just writing words.

## The Book

Jackie is a Feng Shui master, shaman, and spiritual practitioner. The book is a teaching guide / how-to that conveys the unique things she's learned through her gifted experience. Part memoir, part instruction — her particular Feng Shui.

## Core Modes

### 1. Conversation Mode
Live back-and-forth voice dialogue. AI interviews Jackie, asks follow-ups, draws out stories and teachings. Jackie talks, AI listens, responds verbally, and captures everything.

### 2. Dictation Mode
Stream of consciousness capture. Jackie hits a button and talks freely. The AI transcribes, then processes: slicing into paragraphs, proposing where content fits in the book structure, flagging themes.

### 3. Edit Mode
Visual manuscript view with numbered paragraphs in the margin (she never sees Markdown — it's all rendered UI). Jackie can:
- Click/tap a paragraph to discuss it with the AI ("make this clearer", "move this to chapter 3")
- Select text for inline editing
- Reference by number verbally ("paragraph 10, change the color to blue")
- Edit text directly in the browser

## AI Roles

### Interviewer
Ask thoughtful questions to draw out content. "Tell me more about that." "How would you explain this to a student?" "What's the story behind that technique?"

### Editor
Track tone and style consistency. Flag shifts. Suggest rewording. Keep the voice authentically Jackie's.

### Organizer
Maintain chapter structure. Propose where new content fits. Track themes and gaps. "We have a lot about bedroom layout but nothing about kitchens yet."

### Publisher / Author Coach
The AI proactively helps Jackie understand the world of being an author:
- **Book metrics**: word count, estimated page count, how that compares to similar books in the genre
- **Reading level**: offer to evaluate readability (Flesch-Kincaid, etc.) and explain what level is right for her audience
- **Market context**: what do comparable Feng Shui / spiritual teaching books look like? How long are they? How are they structured?
- **Author guidance**: answer questions about the publishing process, what makes a book feel complete, how to think about audience
- **Gentle nudges**: "Would you like me to check the reading level of this chapter?" "We're at about 15,000 words — that's roughly a third of a typical book in this space."

Not a firehose of prompts — just a knowledgeable partner who surfaces the right information at the right time.

## Project Notes

A persistent meta-layer the AI maintains about the book:
- Tone and style guidelines (learned from Jackie's voice and preferences)
- Chapter outline with summaries
- Themes and topics covered vs. gaps
- Jackie's preferences and corrections (learning over time)
- Raw session transcripts for reference
- Book metrics and progress tracking

## Tech Stack

| Component | Choice | Notes |
|-----------|--------|-------|
| Backend | Elixir / Phoenix LiveView | Real-time UI, solid for streaming |
| AI | OpenRouter → Claude Opus 4.6 | Interview/edit/organize/publish brain |
| STT | Web Speech API (browser) | Jackie's voice → text |
| TTS | ElevenLabs API | AI's voice → Jackie's ears |
| Storage | SQLite via Ecto | Chapters, paragraphs, sessions, notes |
| Auth | Basic auth | Password: `JackieJackie` |
| Deployment | Local dev now, Cloudflare later | Domain TBD |

## AI Voice

ElevenLabs voice: warm, nurturing, female, minimal/neutral. A calm creative partner, not a corporate assistant.

## Voice UX

Single toggle: **Voice On / Voice Off**

- **Voice On**: AI is listening (STT active) and will speak responses (TTS active). Conversation flows naturally.
- **Voice Off**: Text-only mode. Type and read. AI doesn't listen or speak.
- **Mute / Pause button**: Instantly stops both listening and speaking. Phone rings? Hit pause. Everything holds. Resume when ready.

The goal: as few controls as possible. One main toggle, one panic button.

## Data Model (SQLite)

```
books
  id, title, description, created_at, updated_at

chapters
  id, book_id, title, position, created_at, updated_at

paragraphs
  id, chapter_id, content, position, created_at, updated_at

sessions
  id, book_id, transcript, summary, mode (conversation/dictation), created_at

project_notes
  id, book_id, key, value, updated_at
  -- tone, style, outline, themes, preferences, etc.
```

Paragraphs have a `position` field — the UI shows position numbers in the margin. Reordering is just updating positions.

## UI

### Main View
- Left sidebar: chapter list + project notes access
- Center: manuscript view with numbered paragraphs in the left margin (clickable)
- Bottom bar: voice on/off toggle + mute/pause button + mode selector (conversation/dictation/edit)
- Right sidebar or overlay: AI chat panel (text fallback + conversation history)

### Mobile
- Single column, voice-first
- Big voice toggle button
- Tap paragraph number to select for discussion
- Swipe between chapters

## Phase 1 (Build This First)

1. Phoenix LiveView app with basic auth
2. SQLite storage with books/chapters/paragraphs/sessions/notes
3. Web Speech API for STT (browser-native)
4. ElevenLabs TTS for AI responses
5. OpenRouter → Opus 4.6 integration for AI conversation
6. Voice on/off toggle with mute/pause
7. Conversation mode: voice back-and-forth with transcript capture
8. Basic manuscript view with numbered paragraphs in margin
9. Project notes panel
10. Publisher coaching basics (word count, reading level, gentle nudges)

## Future

- **THX1138 Mode**: Same engine, different persona. "My time is yours." Project management mirror — captures tasks instead of book content. Reuses TTS/STT infra.
- Multiple AI voices for different roles (interviewer vs. editor vs. publisher)
- Cloudflare deployment + custom domain
- Mobile-optimized PWA
- Version history on paragraphs/chapters
