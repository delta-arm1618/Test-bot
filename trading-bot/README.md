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

### Battles (Bloc 2)
| Command | Description |
|---|---|
| `/battle create 1v1` | Start a 1v1 challenge |
| `/battle create 3v3` | Start a team battle |
| `/battle join` | Join an open lobby |
| `/battle status` | Live scores |
| `/battle history` | Past battles |

### Economy (Bloc 3)
| Command | Description |
|---|---|
| `/hp balance` | Your Hedge Points balance |
| `/shop` | View available boosts |
| `/shop buy` | Purchase a boost |
| `/fund list` | View virtual hedge funds |
| `/fund invest` | Invest HP in a fund |
| `/season current` | Active weekly rule |

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

## Development Roadmap

| Phase | Status | Scope |
|---|---|---|
| **Bloc 1** | ✅ Complete | Foundation, DB, Leaderboard, Invite Gate, Tracking |
| **Bloc 2** | 🔄 Next | Battles 1v1 & 3v3, Competition Manager |
| **Bloc 3** | ⏳ Pending | Hedge Fund, Boutique HP, Volatility Seasons |
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
│   ├── competition/      # /battle (Bloc 2)
│   ├── economy/          # /shop /hp /fund /season (Bloc 3)
│   └── admin/            # /admin
├── events/
│   ├── ready.js
│   ├── guildMemberAdd.js
│   └── interactionCreate.js
├── modules/
│   ├── leaderboard/      # Score engine, tier logic, weekly reset
│   ├── tracking/         # MetaApi polling, EA webhook, metrics parser
│   ├── invites/          # Invite gate, 24h activation
│   ├── battles/          # 1v1/3v3 logic (Bloc 2)
│   ├── hedgefund/        # Virtual funds, HP distribution (Bloc 3)
│   └── seasons/          # Weekly rules, voting (Bloc 3)
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
    └── 001_initial_schema.sql
ea_mt4/
├── TradingBotReporter.mq4  # MT4 Expert Advisor
└── TradingBotReporter.mq5  # MT5 Expert Advisor
tests/
├── unit/                 # Pure unit tests (no DB/Discord)
└── integration/          # End-to-end flow tests (Bloc 4)
```
