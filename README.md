# Discord Guild Ping Bot

Buttons panel per channel. Clicking a button pings the guild role **plus** a default DEF role.

## Setup
1. Copy `.env.example` -> `.env`
2. Fill `DISCORD_TOKEN`
3. `npm i`
4. `npm start`

## Commands
- `/panel_create channel:#... title:"Ping DEF" pin:true`
- `/panel_refresh channel:#...`
- `/guild_add channel:#... name:GTO role:@gto label:GTO emoji:🛡️ order:0`
- `/guild_remove channel:#... name:GTO`

## Notes
- Discord limit: 25 buttons per message.
- Make sure roles are mentionable or bot has MentionEveryone.
