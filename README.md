# Discord Guild Ping Bot

Buttons panel per channel. Clicking a button pings the guild role **plus** a default DEF role.

## Setup
1. Copy `.env.example` -> `.env`
2. Fill `DISCORD_TOKEN`
3. `npm i`
4. `npm start`

### Note “commande obsolète”
Si Discord affiche “commande obsolète”, c’est souvent parce que d’anciennes **commandes globales** traînent encore côté client.
Le bot supprime automatiquement les commandes globales au démarrage et ré-enregistre les commandes **de guilde** (mise à jour quasi instantanée).

## Notes
- Discord limit: 25 buttons per message.
- Make sure roles are mentionable or bot has MentionEveryone.
