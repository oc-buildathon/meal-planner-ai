# MealPrep Agent — Implementation Plan

## Vision

An AI-powered meal prep orchestrator ("Agent Brain") that sits between you and your cook. It learns your taste from past conversations (voice/Hindi, images, reels), proactively decides what to cook, plans meals around your diet, talks to the chef on your behalf via WhatsApp/Telegram, orders groceries from Zepto/Blinkit, and merges friend preferences for group dinners — all with persistent memory. Primary user interface is **WhatsApp** (via Baileys), with Telegram as an additional channel.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Bun + Node.js |
| Backend Framework | NestJS (modular DI, guards, interceptors) |
| Agent Harness | `deepagents` (JS/TS) — subagents, memory, human-in-the-loop, context engineering |
| LLM | Configurable via LangChain `initChatModel` (Claude, GPT, Gemini) |
| Database | PostgreSQL (structured data) + LangGraph Store (agent memory) |
| Cache / Pub-Sub | Redis (sessions, notifications, pub-sub) |
| Messaging (Primary) | WhatsApp via `baileys` (WebSocket-based WA Web API) — user + chef interface |
| Messaging (Secondary) | Telegram Bot API (fallback channel) |
| Voice | Whisper API (Hindi STT) + TTS for responses |
| Calendar | Google Calendar API |
| Grocery | Zepto API + Blinkit API (scraping/unofficial initially) |
| Monorepo | Bun workspaces |

---

## Architecture Layers

### 1. USER LAYER (Input Processing)

Handles all user input modalities before passing to the Agent Brain.

| Component | Description | Tech |
|---|---|---|
| **WhatsApp Bot Gateway** | Primary interface. Receives text, voice notes, images, video/reels, stickers from user via WhatsApp. Handles QR code pairing, session persistence, message queuing. | `baileys` (WhiskeySockets/Baileys) — WebSocket-based WA Web API |
| **Telegram Bot Gateway** | Secondary/fallback channel. Same capabilities as WhatsApp gateway. | `telegraf` or `grammY` |
| **Messaging Abstraction Layer** | Unified interface so the Agent Brain doesn't care which platform a message came from. Normalizes text, audio, image, video into a common `IncomingMessage` type. | Custom NestJS service |
| **Voice Processor** | Hindi voice → text via Whisper. Also TTS for audio responses. Handles WhatsApp `.ogg` voice notes and Telegram voice formats. | OpenAI Whisper API / `@google-cloud/speech` |
| **Multimodal Ingester** | Extracts context from images (food photos), reels (recipe videos), screenshots shared on WhatsApp/Telegram | Vision LLM (GPT-4o / Gemini) via deepagents `read_file` with multimodal support |
| **User Identity** | Each user has a `@username`. Linked to WhatsApp JID and/or Telegram ID. Used for scoping memory, agent palette, diet profiles | PostgreSQL `users` table |

#### WhatsApp via Baileys — Key Details

Baileys (`baileys@7.x`) is a WebSocket-based TS/JS library for WhatsApp Web. It is **not** the official WhatsApp Business API — it reverse-engineers the WA Web protocol. Key considerations:

| Aspect | Detail |
|---|---|
| **Authentication** | QR code scan or phone number pairing. Session state persisted to avoid re-auth. |
| **Message Types** | Text, images, video, audio/voice notes (`.ogg` opus), documents, stickers, reactions, location |
| **Media Download** | `downloadMediaMessage()` to get Buffer of images/audio/video sent by user |
| **Voice Notes** | Received as `.ogg` opus → convert to WAV/MP3 → send to Whisper for Hindi STT |
| **Sending Messages** | `sendMessage(jid, content)` — supports text, image, audio, document, buttons, lists |
| **Session Store** | Auth state stored in DB (PostgreSQL via custom `useMultiFileAuthState` adapter) |
| **Rate Limits** | Must respect WA rate limits — use message queuing (Redis/Bull) to avoid bans |
| **Reconnection** | Baileys handles auto-reconnect; NestJS service wraps lifecycle events |
| **Groups** | Supports group messages — useful for group dinner planning with friends |
| **Disclaimer** | Not officially endorsed by WhatsApp. Use responsibly, no spam/bulk messaging. |

```ts
// Baileys connection setup (simplified)
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from 'baileys';

const { state, saveCreds } = await useMultiFileAuthState('./auth_sessions');
const sock = makeWASocket({ auth: state, printQRInTerminal: true });

sock.ev.on('creds.update', saveCreds);
sock.ev.on('messages.upsert', async ({ messages }) => {
  for (const msg of messages) {
    if (!msg.key.fromMe) {
      // Route to Messaging Abstraction Layer → Agent Brain
      const normalizedMsg = await normalizeWhatsAppMessage(msg);
      await agentOrchestrator.handleMessage(normalizedMsg);
    }
  }
});

// Sending a message back
await sock.sendMessage(userJid, { text: 'Your dinner plan is ready!' });
// Sending an image
await sock.sendMessage(userJid, { image: buffer, caption: 'Today\'s menu' });
```

### 2. AGENT BRAIN (Deep Agents Orchestrator)

The core. A `createDeepAgent` supervisor with specialized subagents.

#### 2.1 Main Orchestrator — `meal-planner-engine`

```ts
const mealPlannerEngine = createDeepAgent({
  model: "anthropic:claude-sonnet-4-20250514",
  systemPrompt: `You are MealPrep, a proactive meal planning agent...`,
  memory: ["/memories/AGENT.md"],
  skills: ["/skills/"],
  subagents: [
    tasteProfileLearner,
    dietHealthTracker,
    socialPlanner,
    chefCommProxy,
    groceryOrderExecutor,
  ],
  backend: new CompositeBackend(
    new StateBackend(),
    {
      "/memories/": new StoreBackend({ namespace: (rt) => [rt.serverInfo.user.identity] }),
      "/taste/": new StoreBackend({ namespace: (rt) => [rt.serverInfo.user.identity] }),
      "/diet/": new StoreBackend({ namespace: (rt) => [rt.serverInfo.user.identity] }),
      "/chat-history/": new StoreBackend({ namespace: (rt) => [rt.serverInfo.user.identity] }),
    },
  ),
  interruptOn: {
    order_groceries: true,       // Human approval before ordering
    send_chef_message: true,     // Human approval before messaging chef
    update_diet_plan: true,      // Confirm diet changes
  },
  checkpointer,
});
```

#### 2.2 Subagents

| Subagent | Name | Description | Tools | Memory Paths |
|---|---|---|---|---|
| **Taste Profile Learner** | `taste-learner` | Analyzes recipes shared, feedback (voice/text), food images, reels. Builds and updates a taste profile. Learns spice preferences, cuisine types, dietary restrictions from patterns. | `analyze_image`, `transcribe_audio`, `update_taste_memory` | `/taste/profile.md`, `/taste/recipes.md`, `/taste/feedback-log.md` |
| **Diet/Health Tracker** | `diet-tracker` | Manages active diet plans (keto, intermittent fasting, etc.), tracks macros, flags conflicts with meal plans. | `get_diet_plan`, `check_nutrition`, `update_diet` | `/diet/active-plan.md`, `/diet/restrictions.md` |
| **Social Planner** | `social-planner` | Multi-agent coordinator. When friends are coming over, merges agent palettes (taste profiles) from multiple users to decide a group dinner menu. | `fetch_friend_palette`, `merge_palettes`, `plan_group_dinner` | `/social/events.md` |
| **Chef Comm Proxy** | `chef-comm` | Talks to the chef on your behalf via WhatsApp (primary) or Telegram. Translates meal plans into cooking instructions, sends grocery lists, handles chef confirmations and schedule. | `send_whatsapp_message`, `send_telegram_message`, `read_chef_response`, `format_recipe_instructions` | `/chat-history/chef-log.md` |
| **Grocery Order Executor** | `grocery-executor` | Connects to Zepto/Blinkit. Maps recipe ingredients → grocery items, checks availability, places orders, tracks delivery. | `search_zepto`, `search_blinkit`, `place_order`, `track_order` | `/orders/history.md` |

### 3. CONNECTORS (External Integrations)

| Connector | Purpose | Integration Pattern |
|---|---|---|
| **Chef WhatsApp** | Primary two-way communication with cook. Send meal plans, receive confirmations, get availability. Natural — the cook already uses WhatsApp. | `baileys` — send/receive via cook's WhatsApp JID |
| **Chef Telegram** | Fallback channel for cook communication | Telegram Bot API — separate bot or same bot with chef-specific chat ID |
| **Zepto API** | Search products, add to cart, place order | REST API / headless browser automation |
| **Blinkit API** | Fallback grocery provider | REST API / headless browser automation |
| **Google Calendar** | Fetch schedule to plan meals around events (dinner party, travel, fasting days) | Google Calendar API v3 with OAuth2 |
| **Notification Engine** | Push notifications: "Order placed", "Chef confirmed", "Dinner planned for 7 PM" | WhatsApp messages (primary) + Telegram (fallback) + optional Firebase push |

### 4. MEMORY / DATA (Persistent Storage)

All powered by `deepagents` `CompositeBackend` + `StoreBackend` for cross-thread persistence.

| Store | Path | Scope | Content |
|---|---|---|---|
| **Taste Memory** | `/taste/` | Per-user | Recipe history, feedback scores, cuisine preferences, spice tolerance, ingredient likes/dislikes |
| **Chat History** | `/chat-history/` | Per-user | Cook communication log, past instructions, chef responses |
| **Agent Palette Registry** | `/palette/` | Per-user (shareable) | Public taste profile summary that can be shared with friends' agents for group planning |
| **Diet Plan Profile** | `/diet/` | Per-user | Active diet (keto, vegan, etc.), calorie targets, allergens, medical restrictions |
| **Order History** | `/orders/` | Per-user | Past grocery orders, preferred brands, price preferences |
| **Social Events** | `/social/` | Per-user | Upcoming dinners, guest lists, merged menu decisions |

### 5. MULTI-AGENT SOCIAL FLOW

When a friend says "I'm coming over for dinner":

```
1. @aryaman sends on WhatsApp: "Rahul is coming for dinner tonight"
2. Social Planner subagent activates
3. Fetches @rahul's Agent Palette (public taste profile) from palette registry
4. Palette Merge Engine:
   - @aryaman likes: spicy, North Indian, no mushrooms
   - @rahul likes: mild, South Indian, vegetarian
   - Merged: South Indian thali, medium spice, no mushrooms, vegetarian
5. Group Dinner Planner creates menu
6. Checks Google Calendar for timing
7. Chef Comm Proxy sends instructions to cook via WhatsApp
8. Grocery Executor orders missing ingredients from Zepto/Blinkit
9. Notification Engine sends confirmation to both users on WhatsApp
   (Can also create/use a WhatsApp group for the dinner plan)
```

---

## Implementation Phases

### Phase 0: Foundation (Week 1-2)

- [ ] Migrate backend from Hono to NestJS
- [ ] Set up PostgreSQL + Redis
- [ ] Configure `deepagents` with `CompositeBackend` (State + Store)
- [ ] Set up LangGraph checkpointer for state persistence
- [ ] **WhatsApp bot via Baileys**: QR auth, session persistence, message handling
- [ ] Messaging Abstraction Layer (normalize WhatsApp + Telegram into common format)
- [ ] Basic Telegram bot as secondary channel
- [ ] User registration + `@username` system (linked to WhatsApp JID + Telegram ID)
- [ ] Message queue (Redis/Bull) for rate-limited outbound WhatsApp messages
- [ ] Environment config (API keys, model selection)

### Phase 1: Core Agent Brain (Week 3-4)

- [ ] Implement main `meal-planner-engine` orchestrator agent
- [ ] Implement `taste-learner` subagent with basic text analysis
- [ ] Memory system: user-scoped `/taste/`, `/memories/` paths
- [ ] Basic meal suggestion flow: user asks → agent suggests based on taste
- [ ] Human-in-the-loop: approval before sending messages/orders
- [ ] Background memory consolidation (cron agent)

### Phase 2: Voice + Multimodal (Week 5-6)

- [ ] Hindi voice input via Whisper API integration
- [ ] Voice response (TTS) for Telegram voice notes
- [ ] Image analysis: food photos → taste learning
- [ ] Reel/video processing: extract recipe from shared content
- [ ] Multimodal backend support via `read_file` with binary/image types

### Phase 3: Chef Communication (Week 7-8)

- [ ] Chef onboarding flow (link chef's WhatsApp number — share contact or enter JID)
- [ ] `chef-comm` subagent: translate meal plans → cooking instructions
- [ ] Two-way WhatsApp relay (user ↔ agent ↔ chef) with Baileys
- [ ] Fallback to Telegram relay if chef prefers Telegram
- [ ] Chef schedule management (availability, off days)
- [ ] Recipe formatting with quantities, steps, timing
- [ ] WhatsApp media: send recipe images, receive cook's food photos

### Phase 4: Grocery Integration (Week 9-10)

- [ ] Zepto product search + cart management
- [ ] Blinkit fallback integration
- [ ] Recipe → ingredient list → grocery mapping
- [ ] Smart substitution (out of stock → alternative)
- [ ] Order placement with human-in-the-loop approval
- [ ] Order tracking + delivery notifications
- [ ] Order history for repeat purchases

### Phase 5: Diet & Health (Week 11-12)

- [ ] Diet plan onboarding (keto, vegan, IF, custom macros)
- [ ] `diet-tracker` subagent: validate meals against diet constraints
- [ ] Nutritional analysis of planned meals
- [ ] Conflict detection: "This recipe has 800 cal, exceeds your dinner target"
- [ ] Diet-aware meal suggestions

### Phase 6: Social & Calendar (Week 13-14)

- [ ] Google Calendar OAuth2 integration
- [ ] Calendar-aware meal planning (events, travel, guests)
- [ ] Agent Palette: public shareable taste summary per user
- [ ] `social-planner` subagent: merge palettes for group dinners
- [ ] Friend system: link `@username` agents
- [ ] Group dinner flow: merge → plan → cook → order → notify
- [ ] Cost splitting for group grocery orders

### Phase 7: Polish & Complementary Features (Week 15-16)

- [ ] Proactive suggestions: "It's Tuesday, last 3 Tuesdays you had dal. Want dal?"
- [ ] Weekly meal prep planner (batch cooking suggestions)
- [ ] Leftover tracking: "You have paneer from yesterday, want palak paneer?"
- [ ] Seasonal/festival awareness (Navratri fasting, Diwali sweets)
- [ ] Budget tracking across grocery orders
- [ ] Recipe discovery: agent suggests new recipes matching your palette
- [ ] Feedback loop: post-meal rating → taste memory update

---

## NestJS Module Structure

```
apps/backend/src/
├── app.module.ts
├── main.ts
│
├── agents/                    # Deep Agents setup
│   ├── agents.module.ts
│   ├── orchestrator.service.ts      # Main meal-planner-engine
│   ├── subagents/
│   │   ├── taste-learner.ts
│   │   ├── diet-tracker.ts
│   │   ├── social-planner.ts
│   │   ├── chef-comm.ts
│   │   └── grocery-executor.ts
│   ├── tools/                       # Custom LangChain tools
│   │   ├── whatsapp.tool.ts         # Send/receive WhatsApp messages
│   │   ├── telegram.tool.ts
│   │   ├── calendar.tool.ts
│   │   ├── grocery.tool.ts
│   │   ├── voice.tool.ts
│   │   └── image-analysis.tool.ts
│   └── memory/
│       ├── memory.service.ts        # Store/backend config
│       └── consolidation.agent.ts   # Background memory consolidation
│
├── messaging/                 # Messaging Abstraction Layer
│   ├── messaging.module.ts
│   ├── messaging.service.ts         # Unified send/receive interface
│   ├── messaging.types.ts           # IncomingMessage, OutgoingMessage types
│   └── adapters/
│       ├── whatsapp.adapter.ts      # Baileys ↔ common format
│       └── telegram.adapter.ts      # Telegraf ↔ common format
│
├── whatsapp/                  # WhatsApp Bot Gateway (Baileys)
│   ├── whatsapp.module.ts
│   ├── whatsapp.service.ts          # Baileys socket lifecycle, reconnect
│   ├── whatsapp.handler.ts          # Message routing (text, voice, image, video)
│   ├── auth/
│   │   └── auth-state.service.ts    # PostgreSQL-backed auth state persistence
│   └── queue/
│       └── message-queue.service.ts # Redis/Bull outbound message rate limiter
│
├── telegram/                  # Telegram Bot Gateway (secondary)
│   ├── telegram.module.ts
│   ├── telegram.service.ts
│   ├── telegram.update.ts           # Message handlers
│   └── guards/
│       └── user-auth.guard.ts
│
├── voice/                     # Voice Processing
│   ├── voice.module.ts
│   ├── stt.service.ts               # Whisper Hindi STT
│   └── tts.service.ts               # Text-to-Speech
│
├── grocery/                   # Grocery Connectors
│   ├── grocery.module.ts
│   ├── zepto.service.ts
│   └── blinkit.service.ts
│
├── calendar/                  # Google Calendar
│   ├── calendar.module.ts
│   └── google-calendar.service.ts
│
├── users/                     # User Management
│   ├── users.module.ts
│   ├── users.service.ts
│   └── entities/
│       ├── user.entity.ts
│       └── agent-palette.entity.ts
│
├── notifications/             # Notification Engine
│   ├── notifications.module.ts
│   └── notifications.service.ts
│
└── common/
    ├── config/
    │   └── configuration.ts
    ├── database/
    │   └── database.module.ts
    └── redis/
        └── redis.module.ts
```

---

## Key Deep Agents Patterns Used

### 1. User-Scoped Long-Term Memory

```ts
backend: new CompositeBackend(
  new StateBackend(),                    // Ephemeral scratch
  {
    "/memories/": new StoreBackend({     // Cross-thread persistent
      namespace: (rt) => [rt.serverInfo.user.identity],
    }),
    "/taste/": new StoreBackend({
      namespace: (rt) => [rt.serverInfo.user.identity],
    }),
  },
),
```

### 2. Subagent Delegation

```ts
subagents: [
  {
    name: "taste-learner",
    description: "Analyzes food images, voice feedback, and recipe shares to update the user's taste profile",
    systemPrompt: tasteProfilePrompt,
    tools: [analyzeImage, transcribeAudio, updateTasteMemory],
    model: "openai:gpt-4o",  // Best for multimodal
  },
  {
    name: "chef-comm",
    description: "Sends meal plans and cooking instructions to the chef via WhatsApp (primary) or Telegram (fallback)",
    systemPrompt: chefCommPrompt,
    tools: [sendWhatsAppMessage, sendTelegramMessage, readChefResponse],
    interruptOn: {
      send_whatsapp_message: true,   // Always confirm before messaging chef on WhatsApp
      send_telegram_message: true,   // Always confirm before messaging chef on Telegram
    },
  },
]
```

### 3. Human-in-the-Loop

```ts
interruptOn: {
  order_groceries: true,            // "Order ₹450 from Zepto? [Approve/Edit/Reject]"
  send_whatsapp_message: true,      // "Send to cook on WhatsApp: Make paneer butter masala for 4? [Approve/Edit/Reject]"
  send_telegram_message: true,      // "Send to cook on Telegram: ... [Approve/Edit/Reject]"
  update_diet_plan: { allowedDecisions: ["approve", "reject"] },
}
```

### 4. Background Memory Consolidation (Cron)

```ts
// Runs every 6 hours — reviews conversations, updates taste/diet memory
const consolidationAgent = createDeepAgent({
  model: "google_genai:gemini-2.5-flash",
  systemPrompt: `Review recent conversations and update:
    - /taste/profile.md with new food preferences
    - /taste/feedback-log.md with meal ratings
    - /diet/active-plan.md if diet changes detected`,
  tools: [searchRecentConversations],
});
```

### 5. Context Engineering

- **Offloading**: Large recipe texts, grocery catalogs auto-offloaded to filesystem
- **Summarization**: Long chef conversations auto-summarized when context fills
- **Skills**: `/skills/indian-cuisine/`, `/skills/keto-planning/` loaded on-demand

---

## Data Models (PostgreSQL)

```sql
-- Core user
CREATE TABLE users (
  id UUID PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,    -- @aryaman
  whatsapp_jid VARCHAR(50) UNIQUE,         -- 919876543210@s.whatsapp.net
  telegram_id BIGINT UNIQUE,
  preferred_channel VARCHAR(20) DEFAULT 'whatsapp',  -- whatsapp | telegram
  chef_whatsapp_jid VARCHAR(50),           -- linked cook's WhatsApp
  chef_telegram_id BIGINT,                 -- linked cook's Telegram (fallback)
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Baileys auth session persistence
CREATE TABLE whatsapp_auth_state (
  session_id VARCHAR(100) PRIMARY KEY,
  creds JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE whatsapp_auth_keys (
  session_id VARCHAR(100) NOT NULL,
  key_id VARCHAR(200) NOT NULL,
  key_data JSONB NOT NULL,
  PRIMARY KEY (session_id, key_id)
);

-- Friend connections for social planning
CREATE TABLE friendships (
  user_id UUID REFERENCES users(id),
  friend_id UUID REFERENCES users(id),
  status VARCHAR(20) DEFAULT 'pending',    -- pending, accepted
  PRIMARY KEY (user_id, friend_id)
);

-- Grocery orders
CREATE TABLE grocery_orders (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  provider VARCHAR(20) NOT NULL,           -- zepto, blinkit
  items JSONB NOT NULL,
  total_amount DECIMAL(10,2),
  status VARCHAR(20) DEFAULT 'pending',
  external_order_id VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Meal plans
CREATE TABLE meal_plans (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  date DATE NOT NULL,
  meal_type VARCHAR(20) NOT NULL,          -- breakfast, lunch, dinner, snack
  recipe JSONB NOT NULL,
  status VARCHAR(20) DEFAULT 'planned',    -- planned, confirmed, cooked, rated
  rating INTEGER,                          -- 1-5 post-meal
  feedback TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## Environment Variables

```env
# LLM
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GOOGLE_API_KEY=

# WhatsApp (Baileys)
WHATSAPP_SESSION_ID=mealprep-bot
WHATSAPP_AUTH_DIR=./auth_sessions

# Telegram (secondary)
TELEGRAM_BOT_TOKEN=
CHEF_CHAT_ID=

# Database
DATABASE_URL=postgresql://...
REDIS_URL=redis://...

# Google Calendar
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=

# Grocery
ZEPTO_API_KEY=
BLINKIT_API_KEY=

# LangSmith (tracing)
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=

# Voice
OPENAI_WHISPER_API_KEY=
```

---

## Complementary Features

1. **Proactive Meal Suggestions** — Agent notices patterns ("Every Monday you eat light") and suggests accordingly
2. **Festival/Season Awareness** — Navratri fasting menus, monsoon comfort food, summer cooling drinks
3. **Budget Mode** — "Keep this week under ₹3000" → agent optimizes ingredient reuse
4. **Leftover Intelligence** — Tracks what was cooked, suggests next-day reuse recipes
5. **Recipe Discovery** — Agent curates new recipes matching your palette score > 0.8
6. **Cook Rating** — Rate meals → feedback loops into taste + cook performance tracking
7. **Weekly Report** — "This week: 5 meals planned, ₹2,100 spent, avg rating 4.2/5"
8. **Meal Photo Log** — Share photo of cooked meal → agent logs it, learns presentation preferences
9. **Guest Dietary Alerts** — Friend is allergic to nuts → auto-flagged in group dinner planning
10. **Quick Reorder** — "Reorder last Tuesday's dinner" → instant chef + grocery flow
