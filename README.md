# Tournée Calendriers — application terrain

Application web pour suivre une tournée de calendriers sur smartphone, hors connexion.
Spécification complète : `C:\Projet\tournees-calendriers\SPEC.md` (§8).

## ⚠️ Règle d'or
Ce dossier est destiné à être **publié** (GitHub Pages, dépôt public).
Il ne contient **que du code** et une démo **fictive**. Ne jamais y copier de vraies données
(sauvegardes, CSV, base Access, fichiers `tournee_*.json` / `retour_*.json`).

## En ligne
https://amicale-bozouls.github.io/tournee/ (dépôt `amicale-bozouls/tournee`, GitHub Pages sur `main` / racine)

## Contenu
- Racine : l'application bénévole (PWA installable, hors connexion).
- `demo/tournee_demo.json` : tournée fictive de test.

## Tester en local
Depuis ce dossier : `python -m http.server 8766` puis ouvrir http://localhost:8766/

## Mettre à jour en ligne
1. Modifier les fichiers.
2. Augmenter `VERSION` dans `sw.js` et `APP_VERSION` dans `app.js`.
3. Sur GitHub : Add file → Upload files, glisser les fichiers modifiés, Commit changes.
   Les téléphones prennent la nouvelle version à la prochaine ouverture avec réseau.
