# 🏆 Trading Competition Bot

**Discord Bot** — Leaderboard Rank Weekly · Battles 1v1 & 3v3 · Demo Account Tracking · Invite Gate · Hedge Fund Mode · Volatility Seasons

---

## Stack
- **Discord.js v14** — Bot framework
- **PostgreSQL** — Persistent storage
- **Redis** — Leaderboard cache + sessions
- **Express** — EA webhook receiver
- **MetaApi** *(optional)* — MT4/MT5 bridge
- **Custom EA** (MQL4/MQL5) — Free MT4/MT5 tracker

---

## Quick Start

### 1. Prerequisites
- Node.js v20+
- PostgreSQL 15+
- Redis 7+

### 2. Clone & Install
```bash
git clone <your-repo>
cd trading-competition-bot
npm install
```

### 3. Configure
```bash
cp .env.example .env
# Fill in all required values in .env
```

**Required variables:**
| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Bot token from Discord Developer Portal |
| `DISCORD_CLIENT_ID` | Application ID |
| `GUILD_ID` | Your server ID |
| `DATABASE_URL` | PostgreSQL connection string |
| `AES_SECRET_KEY` | Exactly 32 characters |
| `JWT_SECRET` | Any long random string |
| `HTTP_SECRET` | Shared secret for EA webhook |

### 4. Run Database Migrations
```bash
npm run db:migrate
```
This applies all migrations in order: `001_initial_schema.sql` → `002_bloc2_battles.sql` → `003_bloc3_economy.sql`

### 5. Deploy Slash Commands
```bash
npm run deploy-commands
# With GUILD_ID set = instant refresh (dev mode)
# Without GUILD_ID = global (1h delay)
```

### 6. Start the Bot
```bash
npm run dev        # Development (auto-restart)
npm start          # Production
```

---

## MT4/MT5 Tracking (Free — No MetaApi needed)

1. Copy `ea_mt4/TradingBotReporter.mq4` (or `.mq5`) into your MT4/MT5 `Experts/` folder
2. Compile it in MetaEditor
3. Attach it to any chart on your demo account
4. Set parameters:
   - `WebhookURL` = `http://your-server-ip:3000/webhook/ea`
   - `WebhookSecret` = your `HTTP_SECRET` from `.env`
   - `AccountID` = the account ID you used with `/account link`
5. In MT4: **Tools → Options → Expert Advisors** → check **Allow WebRequest** → add your server URL

---

## Discord Server Setup

### Required Roles (create these in Discord, then add IDs to .env)
- `@Verified Trader` — Unlocked after invite gate
- `@Bronze`, `@Silver`, `@Gold`, `@Platinum`, `@Diamond`, `@Apex Trader`
- `@Admin` — Can use `/admin` commands

### Required Bot Permissions
- `Manage Roles` — Assign tier roles
- `Create Instant Invite` — Generate referral invite links
- `Send Messages` — DMs and announcements
- `View Audit Log` — Detect invite usage
- `Add Reactions` — Post season vote reactions

---

## Commands Reference

### Leaderboard
| Command | Description |
|---|---|
| `/rank [@user]` | View rank card + weekly stats |
| `/leaderboard [page]` | Top 10 paginated leaderboard |
| `/stats [@user]` | Full metrics breakdown |
| `/history [@user] [weeks]` | Past weekly results |

### Account & Tracking
| Command | Description |
|---|---|
| `/account link` | Link a broker demo account |
| `/account list` | View linked accounts |
| `/account status` | Connection health check |

### Invite Gate
| Command | Description |
|---|---|
| `/invite link` | Get your invite link + status |
| `/invite status` | Count of valid/pending invites |
| `/invite leaderboard` | Top inviters on the server |

### Battles — Bloc 2 ✅
| Command | Description |
|---|---|
| `/battle create 1v1` | Start a 1v1 challenge |
| `/battle create 3v3` | Start a team battle |
| `/battle join` | Join an open lobby with code |
| `/battle status [code]` | Live scores (auto-finds your active battle) |
| `/battle history [@user]` | Past battles + results |

**Battle durations:** 24h · 3d · 7d · 14d · 30d

**3v3 scoring weights by tier:**
| Tier | Weight |
|---|---|
| Diamond / Apex | 40% |
| Gold / Platinum | 35% |
| Bronze / Silver | 25% |

**HP rewards:** 150 HP per battle win · 200 HP for winning captain (3v3)

### Economy — Bloc 3 ✅

#### Hedge Points
| Command | Description |
|---|---|
| `/hp balance [@user]` | HP balance + last 10 transactions |

#### Boost Shop
| Command | Description |
|---|---|
| `/shop browse` | View all boosts and prices |
| `/shop buy` | Purchase a boost |
| `/shop my-boosts` | Your currently active boosts |

**Available boosts:**
| Boost | Cost | Duration | Effect |
|---|---|---|---|
| +1% Max Daily Loss | 500 HP | 1 week | Extends daily loss limit |
| Score Multiplier x1.1 | 800 HP | 1 day | Multiplies composite score |
| Relegation Immunity | 1200 HP | 1 week | Protects from tier relegation |
| Drawdown Reset | 600 HP | One-time | Resets max drawdown counter |
| Battle Priority | 300 HP | One-time | Priority matchmaking |

#### Hedge Funds
| Command | Description |
|---|---|
| `/fund list` | View the 3 active weekly funds |
| `/fund invest` | Invest HP in a fund |
| `/fund history` | Past investments + returns |

**Fund return tiers:**
- 🚀 Top fund (≥ 66% of max score): **1.5x** return
- 📊 Middle fund (33–65%): **1.0x** return (break even)
- 📉 Bottom fund (< 33%): **0.5x** return

#### Volatility Seasons
| Command | Description |
|---|---|
| `/season current` | Active rule for this week |
| `/season upcoming` | Next week's rule (after vote) |
| `/season rules` | All possible season rules |

**Season rules:**
- 💱 Forex Majors Only
- 🔢 Max 2 Trades Per Day
- 📰 No News Trades
- 📈 Long Only
- ⚖️ Max Leverage 1:10

**Vote schedule:** Posted Friday 18:00 UTC · Closes Sunday 23:00 UTC · Activates Monday 00:00 UTC

### Admin
| Command | Description |
|---|---|
| `/admin tracking status` | All broker connection statuses |
| `/admin tracking verify @user` | Manually verify an account |
| `/admin metrics weights` | View scoring formula weights |
| `/admin snapshot` | Force weekly reset |
| `/admin verify-user @user` | Bypass invite gate |
| `/admin give-hp @user amount` | Grant HP manually |
| `/admin submissions` | Review pending screenshots |

---

## Scoring Formula

```
Score = (PnL%) × 0.4 + WinRate × 0.3 + (1 - MaxDrawdown%) × 0.2 + Consistency × 0.1
```

Scores scale to **0–1000 pts**. Configurable via `.env` weight variables.

### Tier System
| Tier | Type | Promotion | Relegation |
|---|---|---|---|
| Bronze 🥉 | Threshold | ≥ 500 pts/week | None |
| Silver 🥈 | Threshold | ≥ 1200 pts/week | < 200 pts |
| Gold 🥇 | Competitive | Top 20% | Bottom 10% |
| Platinum 💎 | Competitive | Top 15% | Bottom 10% |
| Diamond 💠 | Competitive | Top 10% | Bottom 8% |
| Apex 👑 | Competitive | N/A | Bottom 5% |

---

## Cron Schedule

| Job | Schedule | Description |
|---|---|---|
| Weekly Reset | Monday 00:00 UTC | Archive scores, promotions/relegations |
| Hedge Fund Distribution | Monday 00:10 UTC | Distribute HP returns to investors |
| Invite Activation | Every 30 min | Activate pending 24h invites |
| MetaApi Polling | Every 15 min | Refresh broker account metrics |
| Season Vote Post | Friday 18:00 UTC | Post next week's vote in announcements |
| Season Vote Close | Sunday 23:00 UTC | Tally votes, announce winning rule |
| Battle Expiry | Every 5 min | Resolve expired battles |

---

## HP (Hedge Points) — How to Earn

| Source | Amount |
|---|---|
| Per validated invite (24h active) | 100 HP |
| Battle win | 150 HP |
| Battle win as captain (3v3) | 200 HP |
| Hedge fund return (top fund) | 1.5× invested |
| Hedge fund return (middle fund) | 1.0× invested |
| Hedge fund return (bottom fund) | 0.5× invested |
| Admin grant | Variable |

---

## Development Roadmap

| Phase | Status | Scope |
|---|---|---|
| **Bloc 1** | ✅ Complete | Foundation, DB, Leaderboard, Invite Gate, Tracking |
| **Bloc 2** | ✅ Complete | Battles 1v1 & 3v3, Competition Manager |
| **Bloc 3** | ✅ Complete | Hedge Fund, Boutique HP, Volatility Seasons |
| **Bloc 4** | ⏳ Pending | Polish, multi-broker, tests, production deploy |

---

## Architecture

```
src/
├── index.js              # Entry point + Discord client
├── deploy-commands.js    # Slash command registration
├── scheduler.js          # All cron jobs
├── commands/
│   ├── leaderboard/      # /rank /leaderboard /stats /history
│   ├── invite/           # /invite
│   ├── tracking/         # /account
│   ├── competition/      # /battle (Bloc 2) ✅
│   ├── economy/          # /shop /hp /fund /season (Bloc 3) ✅
│   └── admin/            # /admin
├── events/
│   ├── ready.js
│   ├── guildMemberAdd.js
│   └── interactionCreate.js
├── modules/
│   ├── leaderboard/      # Score engine, tier logic, weekly reset
│   ├── tracking/         # MetaApi polling, EA webhook, metrics parser
│   ├── invites/          # Invite gate, 24h activation
│   ├── battles/          # 1v1/3v3 logic (Bloc 2) ✅
│   ├── hedgefund/        # Virtual funds, HP shop, HP distribution (Bloc 3) ✅
│   │   ├── hedgeFundManager.js
│   │   └── shopManager.js
│   └── seasons/          # Weekly rules, voting (Bloc 3) ✅
│       └── seasonManager.js
├── http/
│   └── server.js         # Express: EA webhook + screenshot upload
└── utils/
    ├── logger.js          # Winston structured logging
    ├── crypto.js          # AES-256 for broker credentials
    ├── embeds.js          # Reusable Discord embed builders
    └── redis.js           # Redis client + cache helpers
db/
├── pool.js               # PostgreSQL connection pool
├── migrate.js            # Migration runner
└── migrations/
    ├── 001_initial_schema.sql    # Bloc 1
    ├── 002_bloc2_battles.sql     # Bloc 2
    └── 003_bloc3_economy.sql     # Bloc 3
ea_mt4/
├── TradingBotReporter.mq4  # MT4 Expert Advisor
└── TradingBotReporter.mq5  # MT5 Expert Advisor
tests/
├── unit/
│   ├── scoreEngine.test.js      # Bloc 1
│   ├── metricsParser.test.js    # Bloc 1
│   ├── crypto.test.js           # Bloc 1
│   ├── battleManager.test.js    # Bloc 2
│   └── bloc3Economy.test.js     # Bloc 3
└── integration/                 # End-to-end flow tests (Bloc 4)
```

---

## Running Tests

```bash
npm test              # All tests
npm run test:unit     # Unit tests only (no DB/Discord required)
```

**Unit test coverage:**
- Score formula & consistency calculation
- AES-256 encrypt/decrypt
- EA webhook metrics parser + season trade validation
- Battle 1v1/3v3 score weighting, HP awards, slot validation
- Hedge fund return multipliers + HP validation
- Season rule pool, deterministic week options, shop logic
