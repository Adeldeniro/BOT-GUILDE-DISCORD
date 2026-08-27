# Discord Guild Ping Bot

Buttons panel per channel. Clicking a button pings the guild role **plus** a default DEF role.

## Setup
1. Copy `.env.example` -> `.env`
2. Fill `DISCORD_TOKEN`
3. Use Node `20` (`.nvmrc` included)
4. `npm i`
5. `npm start`

### Note “commande obsolète”
Si Discord affiche “commande obsolète”, c’est souvent parce que d’anciennes **commandes globales** traînent encore côté client.
Le bot supprime automatiquement les commandes globales au démarrage et ré-enregistre les commandes **de guilde** (mise à jour quasi instantanée).

## Notes
- Discord limit: 25 buttons per message.
- Make sure roles are mentionable or bot has MentionEveryone.

## Logs / diagnostic
- The bot now writes logs both to the host console and to `logs/bot-YYYY-MM-DD.log`.
- A heartbeat is emitted every `HEARTBEAT_INTERVAL_SECONDS` seconds with uptime, memory and Discord ping.
- Crash-level process hooks log `uncaughtException`, `unhandledRejection`, signals and Discord shard issues.

Optional env vars:
- `LOG_LEVEL=info`
- `LOG_TO_FILE=true`
- `LOG_DIR=logs`
- `HEARTBEAT_INTERVAL_SECONDS=300`

## Hosting notes
- Recommended Node version: `20`
- `better-sqlite3` and `sharp` are native dependencies, so the host must allow normal npm install scripts / native package installation during deploys.
