# Migration multi-serveur réversible

Cette branche ne doit pas être démarrée avec le token de production avant validation manuelle. Elle conserve `GUILD_ID` comme guilde primaire rétrocompatible et ajoute `GUILD_IDS` pour les autres serveurs.

## Garanties

- Les anciens `DEFAULT_CHANNEL_ID`, `ALERT_CHANNEL_ID`, `DEF_ROLE_ID`, `ADMIN_ROLE_IDS`, `GUILDEUX_ROLE_ID` et `SCOREBOARD_CHANNEL_ID` ne s'appliquent qu'à `GUILD_ID`.
- Une nouvelle guilde reçoit une ligne `guild_config` vide et n'hérite d'aucun salon ou rôle de la guilde primaire.
- Les commandes sont enregistrées séparément dans chaque identifiant de `GUILD_IDS` et `GUILD_ID`.
- Les états SQLite existants sont déjà indexés par `guild_id`.
- Les finances Dragodinde, profils métiers, emojis métiers, sessions et délais sont séparés par `guildId`.
- Aucun token n'est copié dans le dépôt ou le paquet.

## Validation hors réseau

```bash
npm ci
npm test
node --check src/bot.js
```

Les tests utilisent une base SQLite et des répertoires temporaires. Ils ne se connectent pas à Discord.

## Déploiement progressif recommandé

1. Arrêter le processus de test uniquement; ne pas modifier le processus de production.
2. Sauvegarder le dossier de données complet (`data.sqlite`, ses éventuels fichiers `-wal`/`-shm`, et `data/`) pendant que le bot est arrêté.
3. Déployer cette branche dans un nouvel emplacement avec une copie de la sauvegarde et un token de bot de test.
4. Définir `GUILD_ID` sur le serveur historique et `GUILD_IDS` sur le ou les serveurs pilotes.
5. Sur chaque nouvelle guilde, exécuter les commandes de configuration. Pour les métiers, lancer `/metiers-install` dans le salon du dashboard et sélectionner les salons/rôles de cette guilde.
6. Vérifier `/config_status`, les panneaux, le scoreboard, Dragodinde et métiers sur chaque serveur avant toute bascule.
7. Seulement après validation, planifier séparément la bascule de production.

## Migration des fichiers JSON

Au premier accès, les anciens fichiers métiers et Dragodinde sont convertis en structure par guilde. Les anciennes données sont placées exclusivement sous la clé de `GUILD_ID`. Conserver la sauvegarde prise avant démarrage pour revenir au format précédent.

## Retour arrière

1. Arrêter le nouveau processus.
2. Restaurer ensemble la sauvegarde de `data.sqlite`, `data.sqlite-wal`, `data.sqlite-shm` et du dossier `data/`.
3. Redéployer le commit de base `da78021`.
4. Restaurer l'ancien fichier d'environnement avec `GUILD_ID` seul.
5. Redémarrer puis vérifier le panneau historique et le scoreboard.

Ne jamais tenter un retour arrière du code en conservant les fichiers JSON déjà convertis : restaurer code **et** données comme un ensemble.
