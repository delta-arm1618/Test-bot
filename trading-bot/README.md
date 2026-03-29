# 🏆 Trading Competition Bot

**Discord Bot** — Leaderboard Rank Weekly · Battles 1v1 & 3v3 · Demo Account Tracking · Invite Gate · Hedge Fund Mode · Volatility Seasons

---

## Stack

| Composant | Technologie |
|---|---|
| Bot Discord | Discord.js v14 (Node.js 20+) |
| Base de données | PostgreSQL 15 |
| Cache | Redis 7 |
| HTTP / Webhook | Express 4 |
| Tracking MT4/MT5 | Custom EA (MQL4/MQL5) ou MetaApi cloud |
| Tracking cTrader | OAuth 2.0 Open API ✅ Bloc 4 |
| Tracking Tradovate | REST API ✅ Bloc 4 |
| Deploy | Docker + Nginx |
| Monitoring | Winston + Sentry (optionnel) + alertes Discord |

---

## Roadmap

| Phase | Statut | Scope |
|---|---|---|
| **Bloc 1** | ✅ Complet | Foundation, DB, Leaderboard, Invite Gate, EA Tracking |
| **Bloc 2** | ✅ Complet | Battles 1v1 & 3v3, Competition Manager |
| **Bloc 3** | ✅ Complet | Hedge Fund, Boutique HP, Volatility Seasons |
| **Bloc 4** | ✅ Complet | Polish, multi-broker, tests intégration, deploy prod |

---

## Structure du projet

```
trading-competition-bot/
├── src/
│   ├── index.js                         ← Modifié Bloc 4 (init Sentry + circuit breakers)
│   ├── deploy-commands.js
│   ├── scheduler.js                     ← Modifié Bloc 4 (reportCronFailure sur chaque job)
│   ├── commands/
│   │   ├── leaderboard/                 # /rank /leaderboard /stats /history
│   │   ├── invite/                      # /invite
│   │   ├── tracking/                    # /account
│   │   ├── competition/                 # /battle
│   │   ├── economy/                     # /shop /hp /fund /season
│   │   └── admin/
│   │       ├── admin.js                 # Admin core (Bloc 1)
│   │       └── adminExtended.js         ← NOUVEAU Bloc 4
│   ├── events/
│   │   ├── ready.js
│   │   ├── guildMemberAdd.js
│   │   └── interactionCreate.js
│   ├── http/
│   │   └── server.js                    ← Modifié Bloc 4 (rate limiting + validation)
│   ├── middleware/                       ← NOUVEAU Bloc 4
│   │   ├── circuitBreaker.js            # Circuit breaker pour APIs externes
│   │   ├── monitoring.js                # Sentry + alertes Discord
│   │   └── rateLimiter.js               # Rate limiting Redis sliding-window
│   ├── modules/
│   │   ├── leaderboard/
│   │   │   └── scoreEngine.js
│   │   ├── tracking/
│   │   │   ├── accountTracker.js
│   │   │   ├── metricsParser.js
│   │   │   ├── cTraderConnector.js      ← NOUVEAU Bloc 4
│   │   │   └── tradovateConnector.js    ← NOUVEAU Bloc 4
│   │   ├── invites/
│   │   ├── battles/
│   │   ├── hedgefund/
│   │   └── seasons/
│   └── utils/
│       ├── logger.js
│       ├── crypto.js
│       ├── embeds.js
│       └── redis.js
├── db/
│   ├── pool.js
│   ├── migrate.js
│   └── migrations/
│       ├── 001_initial_schema.sql
│       ├── 002_bloc2_battles.sql
│       └── 003_bloc3_economy.sql
├── docker/                              ← NOUVEAU Bloc 4
│   ├── Dockerfile                       # Multi-stage, non-root user, healthcheck
│   ├── docker-compose.yml               # Stack prod: bot + postgres + redis + nginx
│   └── docker-compose.test.yml          # Stack tests isolée (ports 5433 / 6380)
├── nginx/                               ← NOUVEAU Bloc 4
│   ├── nginx.conf
│   └── conf.d/bot.conf                  # Rate limiting Nginx + HTTPS
├── scripts/
│   └── deploy.sh                        ← NOUVEAU Bloc 4 (deploy VPS automatisé)
├── ea_mt4/
│   ├── TradingBotReporter.mq4
│   └── TradingBotReporter.mq5
├── tests/
│   ├── unit/
│   │   ├── scoreEngine.test.js          # Bloc 1
│   │   ├── metricsParser.test.js        # Bloc 1
│   │   ├── crypto.test.js               # Bloc 1
│   │   ├── battleManager.test.js        # Bloc 2
│   │   ├── bloc3Economy.test.js         # Bloc 3
│   │   └── bloc4Hardening.test.js       ← NOUVEAU Bloc 4
│   └── integration/                     ← NOUVEAU Bloc 4
│       ├── flow.onboarding.test.js      # Invite gate → account → score → leaderboard
│       └── flow.weeklyReset.test.js     # Reset hebdo + promotion/relégation
├── package.json                         ← Modifié Bloc 4 (optionalDeps, test:integration)
└── .env.example
```

---

## Installation rapide

### 1. Prérequis
- Node.js v20+
- PostgreSQL 15+
- Redis 7+

### 2. Clone & Install
```bash
git clone <your-repo>
cd trading-competition-bot
npm install
```

### 3. Configuration
```bash
cp .env.example .env
# Remplir toutes les valeurs obligatoires
```

**Variables obligatoires :**
| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Token bot depuis Discord Developer Portal |
| `DISCORD_CLIENT_ID` | Application ID |
| `GUILD_ID` | ID du serveur |
| `DATABASE_URL` | Connexion PostgreSQL |
| `AES_SECRET_KEY` | **Exactement 32 caractères** (AES-256) |
| `JWT_SECRET` | Chaîne aléatoire longue |
| `HTTP_SECRET` | Secret partagé EA ↔ bot |

### 4. Migrations
```bash
npm run db:migrate
```

### 5. Deploy commandes slash
```bash
npm run deploy-commands
```

### 6. Lancer
```bash
npm run dev     # Dev (nodemon)
npm start       # Production
```

---

## Deploy Production (Docker)

### Deploy complet sur VPS
```bash
chmod +x scripts/deploy.sh
./scripts/deploy.sh
```

Le script valide le `.env` (longueur AES key, vars obligatoires), build l'image Docker, démarre PostgreSQL + Redis, applique les migrations, démarre le bot + Nginx, vérifie le health check.

### Mise à jour après modif code
```bash
./scripts/deploy.sh update
```

### Commandes Docker utiles
```bash
# Logs en temps réel
docker compose -f docker/docker-compose.yml logs -f bot

# Shell PostgreSQL
docker compose -f docker/docker-compose.yml exec postgres psql -U botuser -d trading_bot

# Forcer migration
docker compose -f docker/docker-compose.yml exec bot node db/migrate.js

# Deploy slash commands en prod
docker compose -f docker/docker-compose.yml exec bot node src/deploy-commands.js

# Backup BDD
docker compose -f docker/docker-compose.yml exec postgres \
  pg_dump -U botuser trading_bot > backup_$(date +%Y%m%d).sql
```

### SSL Let's Encrypt
```bash
certbot certonly --webroot -w /var/www/html -d yourdomain.com
# Puis mettre à jour nginx/conf.d/bot.conf avec votre domaine
docker compose -f docker/docker-compose.yml restart nginx
```

---

## Tracking MT4/MT5 (Gratuit — sans MetaApi)

1. Copier `ea_mt4/TradingBotReporter.mq4` (ou `.mq5`) dans `Experts/`
2. Compiler dans MetaEditor
3. Attacher à un graphique sur votre compte démo
4. Paramètres :
   - `WebhookURL` = `https://yourdomain.com/webhook/ea`
   - `WebhookSecret` = votre `HTTP_SECRET` du `.env`
   - `AccountID` = l'ID obtenu via `/account link`
5. **Outils → Options → Expert Advisors** → Autoriser WebRequest → ajouter votre domaine

---

## Configuration Discord

### Rôles requis (créer dans Discord, puis ajouter IDs dans `.env`)
- `@Verified Trader` — Débloqué après l'Invite Gate
- `@Bronze`, `@Silver`, `@Gold`, `@Platinum`, `@Diamond`, `@Apex Trader`
- `@Admin` — Peut utiliser `/admin` et `/admin-ext`

### Permissions bot requises
`Manage Roles` · `Create Instant Invite` · `Send Messages` · `View Audit Log` · `Add Reactions`

---

## Commandes

### Leaderboard
| Commande | Description |
|---|---|
| `/rank [@user]` | Carte de rang + stats hebdo |
| `/leaderboard [page]` | Top 10 paginé |
| `/stats [@user]` | Métriques complètes |
| `/history [@user] [weeks]` | Historique semaines passées |

### Compte & Tracking
| Commande | Description |
|---|---|
| `/account link` | Lier un compte démo (MT4/MT5/cTrader/Tradovate/Manuel) |
| `/account list` | Voir les comptes liés |
| `/account status` | Santé de la connexion |

### Invite Gate
| Commande | Description |
|---|---|
| `/invite link` | Votre lien unique + statut |
| `/invite status` | Invitations validées / manquantes |
| `/invite leaderboard` | Top inviters |

### Battles
| Commande | Description |
|---|---|
| `/battle create 1v1` | Créer un duel |
| `/battle create 3v3` | Créer un battle d'équipe |
| `/battle join` | Rejoindre avec le code lobby |
| `/battle status [code]` | Scores en direct |
| `/battle history [@user]` | Battles passées |

**Durées disponibles :** 24h · 3j · 7j · 14j · 30j

### Économie
| Commande | Description |
|---|---|
| `/hp balance [@user]` | Balance HP + 10 dernières transactions |
| `/shop browse` | Tous les boosts + prix |
| `/shop buy` | Acheter un boost |
| `/shop my-boosts` | Boosts actifs |
| `/fund list` | Fonds hedge actifs cette semaine |
| `/fund invest` | Investir des HP dans un fonds |
| `/fund history` | Historique investissements |
| `/season current` | Règle active cette semaine |
| `/season upcoming` | Règle de la semaine prochaine |
| `/season rules` | Toutes les règles possibles |

### Admin (Core — Bloc 1)
| Commande | Description |
|---|---|
| `/admin tracking status` | Statuts connexions brokers |
| `/admin tracking verify @user` | Vérifier manuellement un compte |
| `/admin metrics weights` | Poids de la formule de score |
| `/admin snapshot` | Forcer le reset hebdo |
| `/admin verify-user @user` | Bypass Invite Gate |
| `/admin give-hp @user amount` | Donner des HP |
| `/admin submissions` | Voir les screenshots en attente |

### Admin Extended (Bloc 4) ✅
| Commande | Description |
|---|---|
| `/admin-ext battle cancel` | Annuler un battle actif |
| `/admin-ext battle list-active` | Lister tous les battles ouverts/actifs |
| `/admin-ext fund force-resolve` | Forcer la résolution d'un fonds + distribution HP |
| `/admin-ext fund status` | Statut du fonds de la semaine courante |
| `/admin-ext health dashboard` | Santé système (DB, Redis, circuit breakers, stats) |
| `/admin-ext health reset-breaker` | Réinitialiser un circuit breaker manuellement |
| `/admin-ext user info @user` | Dump complet d'un utilisateur |
| `/admin-ext user reset-hp @user` | Remettre les HP d'un user à 0 |

---

## Formule de score

```
Score = (PnL%) × 0.4 + WinRate × 0.3 + (1 − MaxDrawdown%) × 0.2 + Consistency × 0.1
```

Score normalisé **0–1000 pts**. Poids configurables via `.env`.

### Système de tiers
| Tier | Type | Promotion | Relégation |
|---|---|---|---|
| Bronze 🥉 | Seuil | ≥ 500 pts/sem | Aucune |
| Silver 🥈 | Seuil | ≥ 1200 pts/sem | < 200 pts |
| Gold 🥇 | Compétitif | Top 20% | Bottom 10% |
| Platinum 💎 | Compétitif | Top 15% | Bottom 10% |
| Diamond 💠 | Compétitif | Top 10% | Bottom 8% |
| Apex 👑 | Compétitif | N/A | Bottom 5% |

---

## Planning cron

| Job | Schedule | Description |
|---|---|---|
| Weekly Reset | Lundi 00:00 UTC | Archive scores, promotions/relégations |
| Hedge Fund Distribution | Lundi 00:10 UTC | Distribution HP retours |
| Invite Activation | Toutes les 30 min | Activer invitations 24h+ |
| MetaApi Polling | Toutes les 15 min | Refresh métriques brokers |
| Season Vote | Vendredi 18:00 UTC | Poster vote dans #announcements |
| Season Vote Close | Dimanche 23:00 UTC | Tally + annoncer règle |
| Battle Expiry | Toutes les 5 min | Résoudre battles expirés |

---

## HP (Hedge Points)

| Source | Montant |
|---|---|
| Par invitation validée (24h active) | 100 HP |
| Victoire battle | 150 HP |
| Victoire battle (capitaine 3v3) | 200 HP |
| Retour fonds (top ≥66%) | 1.5× investi |
| Retour fonds (milieu 33–65%) | 1.0× investi |
| Retour fonds (bas <33%) | 0.5× investi |
| Octroi admin | Variable |

---

## Boutique Boosts

| Boost | Coût | Durée | Effet |
|---|---|---|---|
| +1% Max Daily Loss | 500 HP | 1 semaine | Limite de perte journalière étendue |
| Score Multiplier ×1.1 | 800 HP | 1 journée | Multiplie le score composite |
| Relegation Immunity | 1200 HP | 1 semaine | Protection contre la descente de rang |
| Drawdown Reset | 600 HP | Usage unique | Remet le drawdown à zéro |
| Battle Priority Slot | 300 HP | Usage unique | Priorité matchmaking |

---

## Volatility Seasons

| Règle | Vérification |
|---|---|
| 💱 Forex Majors Only | Filtrage par symbole dans l'historique |
| 🔢 Max 2 Trades Per Day | Comptage journalier via API |
| 📰 No News Trades | Blacklist horaires (agenda macro intégré) |
| 📈 Long Only | Vérification direction dans trade history |
| ⚖️ Max Leverage 1:10 | Contrôle taille position vs capital |

**Schedule vote :** Vendredi 18:00 UTC · Clôture Dimanche 23:00 UTC · Activation Lundi 00:00 UTC

---

## Bloc 4 — Détails production

### Rate Limiting (Redis sliding-window)
| Endpoint | Limite | Clé |
|---|---|---|
| `POST /webhook/ea` | 120 req/min | `account_id` |
| `POST /submit-screenshot` | 10 req/heure | IP |
| Tous les endpoints | 300 req/min | IP |

### Circuit Breaker
Protège les appels aux APIs externes (MetaApi, cTrader, Tradovate) :
- **CLOSED** → Fonctionnement normal
- **OPEN** → Rejet immédiat après 5 échecs consécutifs (cooldown 60s)
- **HALF_OPEN** → Sonde : 2 succès consécutifs pour refermer

Chaque changement d'état poste une alerte dans `#announcements`.
Reset manuel : `/admin-ext health reset-breaker`

### Monitoring
- **Sentry** *(optionnel)* — Définir `SENTRY_DSN` dans `.env`
- **Alertes Discord** — Failures cron + circuit breaker OPEN/RECOVER
- **Health endpoint** — `GET /health` → DB + Redis + état circuit breakers

### Multi-broker
| Broker | Méthode | Status |
|---|---|---|
| MT4 / MT5 | Expert Advisor webhook (gratuit) | ✅ |
| MT4 / MT5 | MetaApi cloud | ✅ |
| cTrader | OAuth 2.0 Open API | ✅ Bloc 4 |
| Tradovate | REST API (paper accounts) | ✅ Bloc 4 |
| Manuel | Screenshot + validation admin | ✅ Fallback |

---

## Tests

### Tests unitaires (aucune DB/Discord requise)
```bash
npm run test:unit
```

Couverture :
- Formule score + calcul consistency (Bloc 1)
- AES-256 chiffrement (Bloc 1)
- Parser webhook EA + validation season (Bloc 1)
- Battle 1v1/3v3 scoring, HP rewards, slots (Bloc 2)
- Multiplicateurs retours fonds + validation HP (Bloc 3)
- Pool règles seasons, déterminisme, logique shop (Bloc 3)
- Circuit breaker states, concurrence, reset (Bloc 4) ✅

### Tests d'intégration (PostgreSQL + Redis requis)
```bash
# Démarrer l'infra de test
docker compose -f docker/docker-compose.test.yml up -d

# Lancer les tests
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/trading_bot_test \
TEST_REDIS_URL=redis://localhost:6380/1 \
npm run test:integration

# Nettoyer
docker compose -f docker/docker-compose.test.yml down -v
```

**Suites d'intégration :**
| Suite | Couverture |
|---|---|
| Onboarding Flow | Inscription → invite → 24h activation → unlock → HP → score → leaderboard |
| Battle Flow | Créer → rejoindre → auto-start → expirer → résoudre → HP attribué |
| Economy Flow | Shop items seedés → achat boost → vérif doublon → HP déduits |
| Volatility Seasons | Déterminisme → filtres forex → long_only → max_leverage |
| Weekly Reset | Poids formule → seuil bronze → archivage → mise à jour tiers |

### Tous les tests
```bash
npm test
# ou avec coverage
npm run test:coverage
```

---

## Variables d'environnement — référence complète

```bash
# ── Discord ────────────────────────────────────────────────
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
GUILD_ID=

# ── Database ───────────────────────────────────────────────
DATABASE_URL=postgresql://user:password@localhost:5432/trading_bot
DB_POOL_MIN=2
DB_POOL_MAX=10

# ── Redis ──────────────────────────────────────────────────
REDIS_URL=redis://localhost:6379
REDIS_TTL_LEADERBOARD=300
REDIS_TTL_SESSION=3600

# ── Sécurité ───────────────────────────────────────────────
AES_SECRET_KEY=                # EXACTEMENT 32 caractères
JWT_SECRET=

# ── MetaApi (optionnel) ────────────────────────────────────
METAAPI_TOKEN=
METAAPI_POLL_INTERVAL_MINUTES=15

# ── HTTP (webhook EA) ──────────────────────────────────────
HTTP_PORT=3000
HTTP_SECRET=

# ── Poids scoring (doit sommer à 1.0) ─────────────────────
WEIGHT_PNL=0.4
WEIGHT_WINRATE=0.3
WEIGHT_DRAWDOWN=0.2
WEIGHT_CONSISTENCY=0.1

# ── Tiers ──────────────────────────────────────────────────
GOLD_PROMO_PCT=20
PLAT_PROMO_PCT=15
DIAMOND_PROMO_PCT=10
APEX_PROMO_PCT=5

# ── Invite Gate ───────────────────────────────────────────
INVITE_REQUIRED_COUNT=2
INVITE_ACTIVE_HOURS=24

# ── Rôles Discord ─────────────────────────────────────────
ROLE_VERIFIED_TRADER=
ROLE_BRONZE=
ROLE_SILVER=
ROLE_GOLD=
ROLE_PLATINUM=
ROLE_DIAMOND=
ROLE_APEX=
ROLE_ADMIN=

# ── Channels Discord ──────────────────────────────────────
CHANNEL_ANNOUNCEMENTS=
CHANNEL_LEADERBOARD=
CHANNEL_BATTLES=

# ── Monitoring ────────────────────────────────────────────
SENTRY_DSN=
NODE_ENV=development
LOG_LEVEL=info

# ── Tradovate (optionnel) ─────────────────────────────────
TRADOVATE_ENV=demo
TRADOVATE_CID=0
TRADOVATE_SEC=
```

---

## Runbook opérationnel

### Forcer un reset hebdo
```
/admin snapshot
```

### Récupérer après une panne MetaApi
1. `/admin-ext health dashboard` — vérifier état circuit breaker
2. Si OPEN, attendre récupération ou : `/admin-ext health reset-breaker` → `MetaApi`
3. Le polling reprend automatiquement au prochain tick cron

### Annuler un battle en urgence
```
/admin-ext battle cancel code:XXXYYYYY reason:Raison de l'annulation
```

### Forcer résolution d'un fonds hedge
```
/admin-ext fund force-resolve week:12 year:2026
```

### Backup base de données
```bash
docker compose -f docker/docker-compose.yml exec postgres \
  pg_dump -U botuser trading_bot > backup_$(date +%Y%m%d_%H%M).sql
```

### Restaurer
```bash
docker compose -f docker/docker-compose.yml exec -T postgres \
  psql -U botuser trading_bot < backup_20260101_1200.sql
```
