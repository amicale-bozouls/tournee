/* =============================================
   GESTION DES TOURNÉES — PC (V2)
   Modèle et formats : voir SPEC.md §8.3 et §8.4ter
   ============================================= */

'use strict';

const APP_VERSION = '0.14.0';
const FORMAT_BASE = 'base-tournees-bozouls';
const FORMAT_TOURNEE = 'tournee-bozouls';
const FORMAT_RETOUR = 'retour-tournee-bozouls';
const SCHEMA_VERSION = 1;
const NB_ANNEES_HISTORIQUE = 3;   // années précédentes envoyées au terrain

const STATUTS = {
  a_visiter:     'À passer',
  don:           'Don',
  absent:        'Absent',
  repasser:      'À repasser',
  boite_lettres: 'Boîte aux lettres',
  refuse:        'Refus',
  sans_don:      'Passé sans don',
  autre:         'Autre'
};
// Don reçu par courrier (saisie PC uniquement) : un « don » normal avec mode = 'courrier',
// donc compté dans les totaux et vu comme un don par l'app terrain
const STATUT_COURRIER = 'don_courrier';
const OPTIONS_STATUT = Object.entries(STATUTS).flatMap(e => e[0] === 'don' ? [e, [STATUT_COURRIER, 'Don par courrier']] : [e]);

function valeurStatut(p) {
  return p.statut === 'don' && p.mode === 'courrier' ? STATUT_COURRIER : p.statut;
}

function libelleStatut(p) {
  return valeurStatut(p) === STATUT_COURRIER ? 'Don par courrier' : STATUTS[p.statut] || p.statut;
}

const ETATS = {
  habitee:    'Habitée',
  inhabitee:  'Inhabitée / vide',
  secondaire: 'Résidence secondaire',
  disparue:   'N\'existe plus'
};
const COULEURS = {
  a_visiter: '#8a94a3', don: '#1e8e3e', absent: '#d48a00', repasser: '#7b3fe4',
  boite_lettres: '#0b7fa8', refuse: '#c62828', sans_don: '#6b7480', autre: '#4a5566'
};

// ============================================================
// ÉTAT
// ============================================================
let base = null;              // contenu de base_tournees.json
let indexPassages = new Map(); // "maisonId|annee" -> passage
let indexHistorique = new Set();
let fichier = null;           // FileSystemFileHandle de la base (null = navigateur seulement)
let fichierAutorise = false;  // permission d'écriture accordée dans cette session
let tourneeActiveId = null;
let ecranActif = 'tableau';
let vueTournee = 'tableau';
let rechercheMaison = '';
let filtreStatut = '';
let maisonEditee = null;      // id (null = nouvelle)
let voisineEditee = null;     // id de la maison à côté de laquelle on en ajoute une
let gpsDialogue = null;       // { lat, lng, score, label } trouvé dans la fiche maison
let retourEnCours = null;     // { retour, lignes }
let carte = null, coucheCarte = null;
const marqueursMaison = new Map();   // id de maison -> marqueur de la carte
const selectionPlacement = new Set();   // maisons cochées dans la liste pour être placées ensemble
let placement = null;                // placement à la main en cours : { ids, groupe, repere, auClic }
const LIBELLE_GROUPE = 'Groupe placé à la main';
const LIBELLE_MAISON = 'Placée à la main';
const URL_VUE_AERIENNE = 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}';

const FS_DISPONIBLE = 'showOpenFilePicker' in window;

// ============================================================
// OUTILS
// ============================================================
const $ = (id) => document.getElementById(id);

function esc(valeur) {
  return String(valeur ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function uid(prefixe = '') {
  return prefixe + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function maintenant() { return new Date().toISOString(); }

function normaliser(texte) {
  return String(texte ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

function lireMontant(texte) {
  const n = parseFloat(String(texte ?? '').replace(',', '.').replace(/[^\d.]/g, ''));
  return isNaN(n) ? 0 : Math.round(n * 100) / 100;
}

function euros(n, decimales = true) {
  return (Number(n) || 0).toLocaleString('fr-FR', { minimumFractionDigits: decimales ? 2 : 0, maximumFractionDigits: 2 }) + ' €';
}

function dateCourte(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('fr-FR') + ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function nomFichierSur(texte) {
  return normaliser(texte).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'tournee';
}

let minuteurToast = null;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('visible');
  clearTimeout(minuteurToast);
  minuteurToast = setTimeout(() => el.classList.remove('visible'), 2600);
}

function telecharger(contenu, nom, type) {
  const lien = document.createElement('a');
  lien.href = URL.createObjectURL(new Blob([contenu], { type }));
  lien.download = nom;
  document.body.appendChild(lien);
  lien.click();
  lien.remove();
  setTimeout(() => URL.revokeObjectURL(lien.href), 1000);
}

function lireFichierTexte(f) {
  return new Promise((ok, ko) => {
    const lecteur = new FileReader();
    lecteur.onload = () => ok(lecteur.result);
    lecteur.onerror = () => ko(new Error('Lecture impossible'));
    lecteur.readAsText(f, 'utf-8');
  });
}

// ============================================================
// STOCKAGE NAVIGATEUR (IndexedDB : copie de travail + lien vers le fichier)
// ============================================================
const IDB = {
  ouvrir() {
    return new Promise((ok, ko) => {
      const req = indexedDB.open('gestion-tournees', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => ok(req.result);
      req.onerror = () => ko(req.error);
    });
  },
  async lire(cle) {
    const db = await IDB.ouvrir();
    return new Promise((ok, ko) => {
      const req = db.transaction('kv').objectStore('kv').get(cle);
      req.onsuccess = () => ok(req.result);
      req.onerror = () => ko(req.error);
    });
  },
  async ecrire(cle, valeur) {
    const db = await IDB.ouvrir();
    return new Promise((ok, ko) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(valeur, cle);
      tx.oncomplete = () => ok();
      tx.onerror = () => ko(tx.error);
    });
  },
  async supprimer(cle) {
    const db = await IDB.ouvrir();
    return new Promise((ok) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').delete(cle);
      tx.oncomplete = () => ok();
    });
  }
};

// ============================================================
// BASE
// ============================================================
function nouvelleBase() {
  return {
    format: FORMAT_BASE,
    schemaVersion: SCHEMA_VERSION,
    modifieLe: maintenant(),
    anneeCourante: new Date().getFullYear(),
    tournees: [],
    maisons: [],
    passages: [],
    journal: [],
    historique: []
  };
}

function validerBase(donnees) {
  if (!donnees || donnees.format !== FORMAT_BASE) throw new Error('Ce fichier n\'est pas une base de tournées.');
  if (donnees.schemaVersion > SCHEMA_VERSION) throw new Error('Cette base vient d\'une version plus récente de l\'application.');
  ['tournees', 'maisons', 'passages', 'journal', 'historique'].forEach(k => { if (!Array.isArray(donnees[k])) donnees[k] = []; });
  return donnees;
}

function cle(maisonId, annee) { return maisonId + '|' + annee; }

function cleHistorique(h) {
  return [h.maisonId, h.annee, h.le, h.statut, h.don || 0].join('|');
}

function indexer() {
  indexPassages = new Map(base.passages.map(p => [cle(p.maisonId, p.annee), p]));
  indexHistorique = new Set(base.historique.map(cleHistorique));
}

// Historique des changements d'une maison ; un même retour importé deux fois n'ajoute rien
function noterHistorique(h) {
  const k = cleHistorique(h);
  if (indexHistorique.has(k)) return;
  indexHistorique.add(k);
  base.historique.push(h);
}

function passage(maisonId, annee) {
  return indexPassages.get(cle(maisonId, annee)) || { maisonId, annee, statut: 'a_visiter', don: 0, remarque: '', modifieLe: null };
}

function ecrirePassage(maisonId, annee, valeurs) {
  let p = indexPassages.get(cle(maisonId, annee));
  if (!p) {
    p = { maisonId, annee, statut: 'a_visiter', don: 0, remarque: '' };
    base.passages.push(p);
    indexPassages.set(cle(maisonId, annee), p);
  }
  Object.assign(p, valeurs);
  if (p.statut !== 'don') { p.don = 0; p.mode = ''; }
  if (!p.modifieLe) p.modifieLe = maintenant();
  return p;
}

function journaliser(type, detail, tourneeId = null, annee = null) {
  base.journal.push({ le: maintenant(), type, tourneeId, annee, detail });
}

function tournee(id) { return base.tournees.find(t => t.id === id); }
function maison(id) { return base.maisons.find(m => m.id === id); }
function maisonsDe(tourneeId) { return base.maisons.filter(m => m.tourneeId === tourneeId); }
function estConcernee(m) { return m.etat !== 'inhabitee' && m.etat !== 'disparue'; }

function adresse(m) {
  return [m.numero, m.voie].filter(Boolean).join(' ') || m.lieu || 'Sans adresse';
}

// Replace les maisons ajoutées « à côté » d'une autre, quel que soit leur numéro
function placerVoisines(triees) {
  const ids = new Set(triees.map(m => m.id));
  const liees = new Map(), racines = [];
  for (const m of triees) {
    if (m.voisineId && m.voisineId !== m.id && ids.has(m.voisineId)) {
      if (!liees.has(m.voisineId)) liees.set(m.voisineId, []);
      liees.get(m.voisineId).push(m);
    } else racines.push(m);
  }
  const sortie = [], vues = new Set();
  const poser = (m) => {
    if (vues.has(m.id)) return;
    vues.add(m.id);
    const proches = (liees.get(m.id) || []).sort((a, b) => (a.creeLe || '').localeCompare(b.creeLe || ''));
    proches.filter(x => x.cote === 'avant').forEach(poser);
    sortie.push(m);
    proches.filter(x => x.cote !== 'avant').reverse().forEach(poser);   // la dernière ajoutée reste collée à sa voisine
  };
  racines.forEach(poser);
  triees.forEach(poser);   // sécurité : aucune maison ne doit disparaître
  return sortie;
}

function trierMaisons(liste) {
  return placerVoisines([...liste].sort((a, b) =>
    (a.ordreLieu || 0) - (b.ordreLieu || 0) ||   // l'ordre de passage prime, même à cheval sur deux communes
    normaliser(a.commune).localeCompare(normaliser(b.commune)) ||
    normaliser(a.lieu).localeCompare(normaliser(b.lieu)) ||
    (a.ordreRue || 0) - (b.ordreRue || 0) ||
    normaliser(a.voie).localeCompare(normaliser(b.voie)) ||
    String(a.numero || '').localeCompare(String(b.numero || ''), 'fr', { numeric: true })
  ));
}

function statsTournee(tourneeId, annee) {
  const maisons = maisonsDe(tourneeId).filter(estConcernee);
  let faites = 0, dons = 0, total = 0, totalN1 = 0, calendriers = 0, secondaires = 0;
  for (const m of maisons) {
    const nb = m.nbCalendriers ?? 1;
    calendriers += nb;
    if (m.etat === 'secondaire') secondaires += nb;
    const p = passage(m.id, annee);
    if (p.statut !== 'a_visiter') faites++;
    if (p.statut === 'don') { dons++; total += p.don || 0; }
    const p1 = passage(m.id, annee - 1);
    if (p1.statut === 'don') totalN1 += p1.don || 0;
  }
  return { maisons: maisons.length, faites, dons, total, totalN1, calendriers, secondaires, commande: calendriers - secondaires };
}

function dernierRetour(tourneeId, annee) {
  return base.journal.filter(j => j.type === 'retour' && j.tourneeId === tourneeId && j.annee === annee).map(j => j.le).sort().pop();
}

// ============================================================
// ENREGISTREMENT (fichier + copie navigateur)
// ============================================================
let minuteurEnregistrement = null;

function enregistrer() {
  base.modifieLe = maintenant();
  clearTimeout(minuteurEnregistrement);
  minuteurEnregistrement = setTimeout(enregistrerMaintenant, 600);
}

async function enregistrerMaintenant() {
  const json = JSON.stringify(base);
  try {
    await IDB.ecrire('base', json);
  } catch (e) {
    console.error(e);
    toast('⚠️ Copie navigateur impossible');
  }
  if (fichier && fichierAutorise) {
    try {
      const flux = await fichier.createWritable();
      await flux.write(json);
      await flux.close();
      base._enregistreLe = maintenant();
    } catch (e) {
      console.error('Écriture fichier', e);
      fichierAutorise = false;
    }
  }
  afficherBandeau();
}

async function verifierPermission(demander) {
  if (!fichier) return false;
  const opts = { mode: 'readwrite' };
  try {
    if (await fichier.queryPermission(opts) === 'granted') return true;
    if (demander && await fichier.requestPermission(opts) === 'granted') return true;
  } catch (e) { console.warn(e); }
  return false;
}

function afficherBandeau() {
  const b = $('bandeau-fichier');
  if (!FS_DISPONIBLE) {
    b.className = 'bandeau';
    b.innerHTML = '⚠️ Données enregistrées dans ce navigateur uniquement. Téléchargez régulièrement une copie (⚙). <button class="btn" data-action="telecharger-copie">⬇ Télécharger une copie</button>';
    b.hidden = false;
  } else if (!fichier) {
    b.className = 'bandeau';
    b.innerHTML = '⚠️ Cette base n\'est enregistrée dans aucun fichier. <button class="btn btn-primaire" data-action="lier-fichier">💾 Choisir le fichier d\'enregistrement</button>';
    b.hidden = false;
  } else if (!fichierAutorise) {
    b.className = 'bandeau';
    b.innerHTML = `⚠️ L'enregistrement dans <b>${esc(fichier.name)}</b> est en pause. <button class="btn btn-primaire" data-action="reactiver-fichier">▶ Réactiver l'enregistrement</button>`;
    b.hidden = false;
  } else {
    b.className = 'bandeau ok';
    b.innerHTML = `✓ Enregistré automatiquement dans <b>${esc(fichier.name)}</b>${base._enregistreLe ? ' — ' + dateCourte(base._enregistreLe) : ''}`;
    b.hidden = false;
  }
}

async function chargerBase(donnees, handle) {
  base = validerBase(donnees);
  delete base._enregistreLe;
  indexer();
  fichier = handle || null;
  fichierAutorise = handle ? await verifierPermission(false) : false;
  await IDB.ecrire('base', JSON.stringify(base));
  if (handle) await IDB.ecrire('fichier', handle); else await IDB.supprimer('fichier');
  tourneeActiveId = base.tournees[0] ? base.tournees[0].id : null;
  $('ecran-demarrage').hidden = true;
  $('ecran-app').hidden = false;
  afficherBandeau();
  rendreTout();
}

async function ouvrirBase() {
  if (!FS_DISPONIBLE) { $('fichier-base').click(); return; }
  try {
    const [handle] = await window.showOpenFilePicker({ types: [{ description: 'Base des tournées', accept: { 'application/json': ['.json'] } }] });
    const texte = await (await handle.getFile()).text();
    const donnees = JSON.parse(texte);
    if (!(await confirmerRemplacement())) return;
    await chargerBase(donnees, handle);
    fichierAutorise = await verifierPermission(true);
    afficherBandeau();
    toast('📂 Base ouverte');
  } catch (e) {
    if (e.name !== 'AbortError') alert('❌ ' + (e instanceof SyntaxError ? 'Fichier illisible.' : e.message));
  }
}

async function choisirFichierEnregistrement() {
  const handle = await window.showSaveFilePicker({
    suggestedName: 'base_tournees.json',
    types: [{ description: 'Base des tournées', accept: { 'application/json': ['.json'] } }]
  });
  fichier = handle;
  fichierAutorise = true;
  await IDB.ecrire('fichier', handle);
  await enregistrerMaintenant();
}

async function creerBase() {
  if (!(await confirmerRemplacement())) return;
  const vide = nouvelleBase();
  if (FS_DISPONIBLE) {
    try {
      base = vide;
      await chargerBase(vide, null);
      await choisirFichierEnregistrement();
      toast('✨ Nouvelle base créée');
    } catch (e) {
      if (e.name !== 'AbortError') alert('❌ ' + e.message);
    }
  } else {
    await chargerBase(vide, null);
  }
}

async function confirmerRemplacement() {
  if (!base || base.tournees.length === 0) return true;
  return confirm('Fermer la base actuelle ?\n\nElle reste enregistrée dans son fichier, mais pensez à télécharger une copie si elle n\'est liée à aucun fichier.');
}

function telechargerCopie() {
  const date = new Date().toISOString().slice(0, 10);
  telecharger(JSON.stringify(base, null, 1), `copie_base_tournees_${date}.json`, 'application/json');
  journaliser('copie', 'Copie téléchargée');
  enregistrer();
}

// ============================================================
// RENDU GÉNÉRAL
// ============================================================
function rendreTout() {
  const a = base.anneeCourante;
  $('annee-courante').textContent = a;
  document.querySelectorAll('.annee-texte').forEach(el => { el.textContent = a; });
  document.querySelectorAll('.annee-precedente-texte').forEach(el => { el.textContent = a - 1; });
  rendreListeTournees();
  afficherEcran(ecranActif);
}

function afficherEcran(nom) {
  ecranActif = nom;
  document.querySelectorAll('.onglet').forEach(b => b.classList.toggle('actif', b.dataset.ecran === nom));
  $('ecran-tableau').hidden = nom !== 'tableau';
  $('ecran-tournee').hidden = nom !== 'tournee';
  if (nom === 'tableau') rendreTableauDeBord();
  else rendreTournee();
}

function rendreListeTournees() {
  const a = base.anneeCourante;
  const tournees = [...base.tournees].sort((x, y) => (x.ordre || 0) - (y.ordre || 0) || normaliser(x.nom).localeCompare(normaliser(y.nom)));
  $('liste-tournees').innerHTML = tournees.map(t => {
    const s = statsTournee(t.id, a);
    const pct = s.maisons ? Math.round(s.faites / s.maisons * 100) : 0;
    return `<li><button data-tournee="${esc(t.id)}" class="${t.id === tourneeActiveId && ecranActif === 'tournee' ? 'actif' : ''}">
      <span class="nom">${esc(t.nom)}</span>
      <span class="mini-barre"><div style="width:${pct}%"></div></span>
      <span class="sous"><span>${s.faites}/${s.maisons}</span><span>${euros(s.total, false)}</span></span>
    </button></li>`;
  }).join('') || '<li class="discret" style="padding:8px 10px">Aucune tournée.</li>';
}

function carteChiffre(valeur, libelle, classe = '') {
  return `<div class="chiffre"><b class="${classe}">${valeur}</b><span>${esc(libelle)}</span></div>`;
}

function evolution(total, totalN1) {
  if (!totalN1) return '';
  const pct = Math.round((total - totalN1) / totalN1 * 100);
  return `<span class="${pct >= 0 ? 'evol-plus' : 'evol-moins'}">${pct >= 0 ? '+' : ''}${pct} %</span>`;
}

// ============================================================
// TABLEAU DE BORD
// ============================================================
function rendreTableauDeBord() {
  const a = base.anneeCourante;
  let maisons = 0, faites = 0, dons = 0, total = 0, totalN1 = 0, calendriers = 0, secondaires = 0;
  const lignes = [...base.tournees].sort((x, y) => normaliser(x.nom).localeCompare(normaliser(y.nom), 'fr', { numeric: true })).map(t => {
    const s = statsTournee(t.id, a);
    maisons += s.maisons; faites += s.faites; dons += s.dons; total += s.total; totalN1 += s.totalN1;
    calendriers += s.calendriers; secondaires += s.secondaires;
    const pct = s.maisons ? Math.round(s.faites / s.maisons * 100) : 0;
    return `<tr class="lien" data-tournee="${esc(t.id)}">
      <td><b>${esc(t.nom)}</b></td><td>${esc(t.responsable || '')}</td>
      <td class="num">${s.maisons}</td>
      <td class="num">${s.calendriers}</td><td class="num">${s.secondaires}</td><td class="num"><b>${s.commande}</b></td>
      <td><div class="mini-barre" style="width:120px;display:inline-block;vertical-align:middle"><div style="width:${pct}%"></div></div> ${pct} %</td>
      <td class="num">${s.dons}</td><td class="num">${euros(s.total)}</td><td class="num">${euros(s.totalN1)}</td>
      <td class="num">${evolution(s.total, s.totalN1)}</td>
      <td>${dateCourte(dernierRetour(t.id, a))}</td>
    </tr>`;
  });
  $('tableau-corps').innerHTML = lignes.join('') || '<tr><td colspan="12" class="vide">Aucune tournée. Créez-en une avec ＋ ou importez une sauvegarde (⚙).</td></tr>';
  $('tableau-chiffres').innerHTML =
    carteChiffre(base.tournees.length, 'tournées') +
    carteChiffre(calendriers - secondaires, `calendriers à commander (${calendriers} − ${secondaires} secondaires)`) +
    carteChiffre(`${faites} / ${maisons}`, 'maisons visitées') +
    carteChiffre(dons, 'dons') +
    carteChiffre(euros(total), `total ${a}`) +
    carteChiffre(euros(totalN1), `total ${a - 1}`) +
    (totalN1 ? carteChiffre(evolution(total, totalN1), 'évolution') : '');
}

// ============================================================
// FICHE TOURNÉE
// ============================================================
function rendreTournee() {
  const t = tournee(tourneeActiveId);
  $('tournee-vide').hidden = !!t;
  $('tournee-active').hidden = !t;
  rendreListeTournees();
  if (!t) return;
  const a = base.anneeCourante;
  $('tournee-nom').textContent = t.nom;
  $('tournee-infos').textContent = [t.responsable && 'Responsable : ' + t.responsable, t.secteur].filter(Boolean).join(' · ');
  document.querySelectorAll('.annee-n1').forEach(el => { el.textContent = a - 1; });
  document.querySelectorAll('.annee-n2').forEach(el => { el.textContent = a - 2; });
  rendreChiffresTournee();
  if (vueTournee === 'carte') rendreCarte(true);
  else rendreMaisons();
}

function rendreChiffresTournee() {
  const a = base.anneeCourante;
  const s = statsTournee(tourneeActiveId, a);
  const maisons = maisonsDe(tourneeActiveId);
  const repasser = maisons.filter(m => estConcernee(m) && ['absent', 'repasser'].includes(passage(m.id, a).statut)).length;
  const sansGps = maisons.filter(m => m.lat == null).length;
  const aValider = maisons.filter(m => m.nouvelle).length;
  $('tournee-chiffres').innerHTML =
    carteChiffre(`${s.faites} / ${s.maisons}`, 'visitées') +
    carteChiffre(s.commande, `calendriers à commander (${s.calendriers} − ${s.secondaires} secondaires)`) +
    carteChiffre(s.dons, 'dons') +
    carteChiffre(euros(s.total), `total ${a}`) +
    carteChiffre(euros(s.totalN1), `total ${a - 1}`) +
    carteChiffre(repasser, 'absents / à repasser') +
    (aValider ? carteChiffre(aValider, 'nouvelles à valider', 'evol-moins') : '') +
    (sansGps ? carteChiffre(sansGps, 'sans position GPS') : '');
}

function texteHistorique(p) {
  if (p.statut === 'a_visiter') return '';
  if (p.statut === 'sans_don') return euros(0, false);
  if (valeurStatut(p) === STATUT_COURRIER) return euros(p.don) + ' ✉';
  return p.statut === 'don' ? euros(p.don) : STATUTS[p.statut] || p.statut;
}

function sansPosition(m) {
  return m.lat == null && m.etat !== 'disparue';
}

// Une position exacte n'est jamais sélectionnable : elle ne peut bouger que maison par maison
function placable(m) {
  return m.etat !== 'disparue' && (m.lat == null || m.posApprochee);
}

function correspondFiltres(m, a) {
  if (filtreStatut) {
    if (filtreStatut === 'nouvelle') { if (!m.nouvelle) return false; }
    else if (filtreStatut === 'sans_position') { if (!sansPosition(m)) return false; }
    else if (filtreStatut === 'approchee') { if (m.lat == null || !m.posApprochee) return false; }
    else if (filtreStatut === 'don') { if (passage(m.id, a).statut !== 'don') return false; }   // tous les dons, courrier compris
    else if (valeurStatut(passage(m.id, a)) !== filtreStatut) return false;
  }
  if (!rechercheMaison) return true;
  const q = normaliser(rechercheMaison);
  return [m.numero, m.voie, m.lieu, m.commune, m.nom, m.infos, passage(m.id, a).remarque].some(v => normaliser(v).includes(q));
}

function rendreMaisons() {
  const a = base.anneeCourante;
  const maisons = trierMaisons(maisonsDe(tourneeActiveId)).filter(m => correspondFiltres(m, a));
  const optionsStatut = OPTIONS_STATUT;
  let html = '', dernierGroupe = null, n = 0;
  for (const m of maisons) {
    const groupe = [m.commune, m.lieu].filter(Boolean).join(' — ') || 'Sans lieu-dit';
    if (groupe !== dernierGroupe) {
      html += `<tr class="groupe"><td colspan="12">📍 ${esc(groupe)}${m.ordreLieu ? ` <span class="discret">(ordre ${m.ordreLieu})</span>` : ''}</td></tr>`;
      dernierGroupe = groupe;
    }
    n++;
    const p = passage(m.id, a);
    const etiquettes = (m.etat !== 'habitee' ? ` <span class="etiquette">${esc(ETATS[m.etat] || m.etat)}</span>` : '') +
                       (m.nouvelle ? ' <span class="etiquette etiquette-nouvelle">Nouvelle — à valider</span>' : '');
    html += `<tr data-id="${esc(m.id)}" class="${estConcernee(m) ? '' : 'inactive'}">
      <td>${placable(m) ? `<input type="checkbox" class="choix-placement" title="Sélectionner pour placer sur la carte"${selectionPlacement.has(m.id) ? ' checked' : ''} />` : ''}</td>
      <td class="num">${n}</td>
      <td>${esc(m.numero)}</td>
      <td>${esc(m.voie)}${m.lat == null ? ' <span title="Pas de position GPS">📍?</span>' : (m.posApprochee ? ' <span title="Position approchée (rue, hameau ou voisine)">≈</span>' : '')}</td>
      <td>${esc(m.nom)}${m.infos ? `<div class="discret" style="font-size:12px">ℹ️ ${esc(m.infos)}</div>` : ''}</td>
      <td>${etiquettes.trim() || '<span class="discret">Habitée</span>'}</td>
      <td class="num discret">${esc(texteHistorique(passage(m.id, a - 2)))}</td>
      <td class="num discret">${esc(texteHistorique(passage(m.id, a - 1)))}</td>
      <td><select class="statut-select" data-champ="statut" data-statut="${esc(valeurStatut(p))}">
        ${optionsStatut.map(([k, l]) => `<option value="${k}"${k === valeurStatut(p) ? ' selected' : ''}>${esc(l)}</option>`).join('')}
      </select></td>
      <td><input class="saisie-don" data-champ="don" inputmode="decimal" value="${p.statut === 'don' && p.don ? esc(String(p.don).replace('.', ',')) : ''}" /></td>
      <td><input data-champ="remarque" value="${esc(p.remarque || '')}" title="${esc(p.benevole ? 'Saisi par ' + p.benevole : '')}" /></td>
      <td style="white-space:nowrap">${m.lat != null ? '<button class="btn-icone" data-action="voir-carte" title="Voir sur la carte">📍</button>' : '<button class="btn-icone" data-action="placer-carte" title="Placer sur la carte">📌</button>'}<button class="btn-icone" data-action="ajouter-a-cote" title="Ajouter une maison à côté">➕</button><button class="btn-icone" data-action="modifier-maison" title="Fiche maison">✏️</button></td>
    </tr>`;
  }
  $('maisons-corps').innerHTML = html ||
    `<tr><td colspan="12" class="vide">${rechercheMaison || filtreStatut ? 'Aucune maison pour ce filtre.' : 'Aucune maison. Ajoutez-en avec « ➕ Maison ».'}</td></tr>`;
  rendreSelection();
}

// Sélection multiple des maisons sans position ou à position approchée, pour les placer ensemble
function maisonsPlacablesVisibles() {
  return maisonsDe(tourneeActiveId).filter(m => placable(m) && correspondFiltres(m, base.anneeCourante));
}

function rendreSelection() {
  const visibles = maisonsPlacablesVisibles();
  const n = selectionPlacement.size;
  $('barre-selection').hidden = visibles.length === 0 && n === 0;
  $('selection-texte').textContent = n ? `${n} maison(s) sélectionnée(s)` : `${visibles.length} maison(s) à placer (sans position ou ≈)`;
  $('btn-tout-cocher').textContent = `Tout cocher (${visibles.length})`;
  $('btn-tout-cocher').hidden = visibles.length === 0;
  $('btn-tout-decocher').hidden = n === 0;
  $('btn-placer-selection').disabled = n === 0;
}

function cocherTout(cocher) {
  if (cocher) maisonsPlacablesVisibles().forEach(m => selectionPlacement.add(m.id));
  else selectionPlacement.clear();
  rendreMaisons();
}

function placerSelection() {
  const ids = [...selectionPlacement].filter(id => maison(id) && placable(maison(id)));
  if (!ids.length) return;
  demarrerPlacement(ids[0], { ids, titre: 'Sélection' });
}

// Saisie directe dans le tableau (retours papier, dons remis en main propre…)
function saisieTableau(e) {
  const champ = e.target.dataset.champ;
  const ligne = e.target.closest('tr[data-id]');
  if (!champ || !ligne) return;
  const id = ligne.dataset.id;
  const a = base.anneeCourante;
  const actuel = passage(id, a);
  const etatAvant = `${valeurStatut(actuel)}|${actuel.don || 0}`;
  const valeurs = { modifieLe: maintenant(), source: 'pc', benevole: '' };

  if (champ === 'statut') {
    valeurs.statut = e.target.value === STATUT_COURRIER ? 'don' : e.target.value;
    valeurs.mode = e.target.value === STATUT_COURRIER ? 'courrier' : '';
    valeurs.don = valeurs.statut === 'don' ? actuel.don : 0;
  } else if (champ === 'don') {
    const montant = lireMontant(e.target.value);
    valeurs.don = montant;
    if (montant > 0) valeurs.statut = 'don';
    else if (actuel.statut === 'don') valeurs.statut = 'don';
  } else if (champ === 'remarque') {
    valeurs.remarque = e.target.value.trim();
  }
  const p = ecrirePassage(id, a, valeurs);
  p.modifieLe = valeurs.modifieLe;
  // Un don encore sans montant n'est pas noté : le changement l'est quand le montant est saisi
  if (`${valeurStatut(p)}|${p.don || 0}` !== etatAvant && !(p.statut === 'don' && !p.don)) {
    noterHistorique({ maisonId: id, annee: a, le: p.modifieLe, statut: p.statut, don: p.don || 0, mode: p.mode || '', qui: '', source: 'pc' });
  }

  // Mise à jour locale de la ligne sans tout redessiner (garde le focus pour la saisie au clavier)
  const select = ligne.querySelector('[data-champ="statut"]');
  select.value = valeurStatut(p);
  select.dataset.statut = valeurStatut(p);
  const don = ligne.querySelector('[data-champ="don"]');
  if (document.activeElement !== don || champ === 'statut') don.value = p.statut === 'don' && p.don ? String(p.don).replace('.', ',') : '';
  if (champ === 'statut' && e.target.value === STATUT_COURRIER) don.focus();   // reste à saisir le montant

  enregistrer();
  rendreChiffresTournee();
  rendreListeTournees();
}

// ============================================================
// TOURNÉES (créer / modifier / supprimer)
// ============================================================
let tourneeEditee = null;

function ouvrirDialogueTournee(id) {
  tourneeEditee = id;
  const t = id ? tournee(id) : null;
  $('dlg-tournee-titre').textContent = t ? 'Modifier la tournée' : 'Nouvelle tournée';
  $('t-nom').value = t ? t.nom : '';
  $('t-responsable').value = t ? t.responsable || '' : '';
  $('t-secteur').value = t ? t.secteur || '' : '';
  $('btn-supprimer-tournee').hidden = !t;
  $('dlg-tournee').showModal();
  $('t-nom').focus();
}

function enregistrerTournee() {
  const nom = $('t-nom').value.trim();
  if (!nom) { $('t-nom').focus(); return; }
  const valeurs = { nom, responsable: $('t-responsable').value.trim(), secteur: $('t-secteur').value.trim() };
  if (tourneeEditee) {
    Object.assign(tournee(tourneeEditee), valeurs);
  } else {
    const t = { id: uid('t-'), ordre: base.tournees.length + 1, ...valeurs };
    base.tournees.push(t);
    tourneeActiveId = t.id;
    ecranActif = 'tournee';
  }
  $('dlg-tournee').close();
  enregistrer();
  rendreTout();
}

function supprimerTournee() {
  const t = tournee(tourneeEditee);
  const nb = maisonsDe(t.id).length;
  if (!confirm(`Supprimer la tournée « ${t.nom} » et ses ${nb} maison(s), avec tout leur historique ?\n\nCette action est définitive.`)) return;
  const ids = new Set(maisonsDe(t.id).map(m => m.id));
  base.maisons = base.maisons.filter(m => !ids.has(m.id));
  base.passages = base.passages.filter(p => !ids.has(p.maisonId));
  base.tournees = base.tournees.filter(x => x.id !== t.id);
  journaliser('suppression', `Tournée « ${t.nom} » supprimée (${nb} maisons)`);
  indexer();
  tourneeActiveId = base.tournees[0] ? base.tournees[0].id : null;
  $('dlg-tournee').close();
  enregistrer();
  rendreTout();
}

// ============================================================
// FICHE MAISON
// ============================================================
function remplirListes() {
  const ens = { communes: new Set(), lieux: new Set(), voies: new Set() };
  base.maisons.forEach(m => {
    if (m.commune) ens.communes.add(m.commune);
    if (m.lieu) ens.lieux.add(m.lieu);
    if (m.voie) ens.voies.add(m.voie);
  });
  const options = (s) => [...s].sort().map(v => `<option value="${esc(v)}">`).join('');
  $('liste-communes').innerHTML = options(ens.communes);
  $('liste-lieux').innerHTML = options(ens.lieux);
  $('liste-voies').innerHTML = options(ens.voies);
}

function ouvrirDialogueMaison(id, voisineId = null) {
  maisonEditee = id;
  const m = id ? maison(id) : null;
  const voisine = voisineId ? maison(voisineId) : null;
  voisineEditee = voisine ? voisine.id : null;
  gpsDialogue = null;
  remplirListes();
  $('m-etat').innerHTML = Object.entries(ETATS).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('');
  $('m-tournee').innerHTML = base.tournees.map(t => `<option value="${esc(t.id)}">${esc(t.nom)}</option>`).join('');

  // Nouvelle maison : on reprend commune / lieu / voie de la dernière maison de la tournée
  const modele = m || voisine || trierMaisons(maisonsDe(tourneeActiveId)).pop() || {};
  $('dlg-maison-titre').textContent = m ? adresse(m) : (voisine ? `Nouvelle maison à côté de : ${adresse(voisine)}` : 'Nouvelle maison');
  $('m-cote-ligne').hidden = !voisine;
  $('m-cote').value = 'apres';
  $('m-commune').value = modele.commune || '';
  $('m-lieu').value = modele.lieu || '';
  $('m-ordre-lieu').value = modele.ordreLieu || '';
  $('m-numero').value = m ? m.numero || '' : '';
  $('m-voie').value = modele.voie || '';
  $('m-ordre-rue').value = modele.ordreRue || '';
  $('m-nom').value = m ? m.nom || '' : '';
  $('m-etat').value = m ? m.etat || 'habitee' : 'habitee';
  $('m-tournee').value = m ? m.tourneeId : (voisine ? voisine.tourneeId : tourneeActiveId);
  $('m-infos').value = m ? m.infos || '' : '';
  $('m-calendriers').value = m ? m.nbCalendriers ?? 1 : 1;
  $('m-gps').textContent = m && m.lat != null
    ? `Position${m.posApprochee ? ' approchée' : ''} : ${m.lat.toFixed(5)}, ${m.lng.toFixed(5)}`
    : (voisine && voisine.lat != null ? 'Position : approchée (voisine)' : 'Position : —');
  $('m-gps-resultat').textContent = m && m.geoLabel ? `BAN : ${m.geoLabel}` : '';

  const passages = m ? base.passages.filter(p => p.maisonId === m.id && p.statut !== 'a_visiter').sort((x, y) => y.annee - x.annee) : [];
  $('m-historique').innerHTML = passages.map(p =>
    `<span><b>${p.annee}</b> : ${esc(texteHistorique(p))}${p.remarque ? ' — ' + esc(p.remarque) : ''}${p.benevole ? ` <i class="discret">(${esc(p.benevole)})</i>` : ''}</span>`
  ).join('') || '<span class="discret">Aucun passage enregistré.</span>';

  $('btn-supprimer-maison').hidden = !m;
  $('btn-placer-carte').hidden = !m;
  const hameau = m ? maisonsDuHameau(m) : [];
  $('btn-placer-hameau').hidden = hameau.length < 2;
  $('btn-placer-hameau').textContent = `🏘 Placer tout le hameau (${hameau.length})`;
  $('dlg-maison').showModal();
}

function enregistrerMaison() {
  const valeurs = {
    commune: $('m-commune').value.trim(),
    lieu: $('m-lieu').value.trim(),
    ordreLieu: parseInt($('m-ordre-lieu').value) || 0,
    numero: $('m-numero').value.trim(),
    voie: $('m-voie').value.trim(),
    ordreRue: parseInt($('m-ordre-rue').value) || 0,
    nom: $('m-nom').value.trim(),
    etat: $('m-etat').value,
    tourneeId: $('m-tournee').value,
    infos: $('m-infos').value.trim(),
    nbCalendriers: Math.max(parseInt($('m-calendriers').value) || 0, 0)
  };
  if (!valeurs.voie && !valeurs.lieu) { alert('Indiquez au moins une voie ou un lieu-dit.'); return; }
  if (gpsDialogue) Object.assign(valeurs, { lat: gpsDialogue.lat, lng: gpsDialogue.lng, geoScore: gpsDialogue.score, geoLabel: gpsDialogue.label, posApprochee: false });

  if (maisonEditee) {
    const m = maison(maisonEditee);
    Object.assign(m, valeurs);
    m.nouvelle = false;   // une maison relue et enregistrée sur le PC est validée
  } else {
    const voisine = voisineEditee ? maison(voisineEditee) : null;
    const position = voisine && voisine.lat != null ? { lat: voisine.lat, lng: voisine.lng, posApprochee: true } : {};
    const placement = voisine ? { voisineId: voisine.id, cote: $('m-cote').value } : {};
    base.maisons.push({ id: uid('m-'), lat: null, lng: null, nouvelle: false, refExterne: '', creeLe: maintenant(), ...position, ...placement, ...valeurs });
  }
  $('dlg-maison').close();
  enregistrer();
  rendreTournee();
  toast('💾 Maison enregistrée');
}

function supprimerMaison() {
  const m = maison(maisonEditee);
  if (!confirm(`Supprimer définitivement « ${adresse(m)} » et son historique ?\n\nSi la maison n'existe plus, préférez l'état « N'existe plus » pour garder l'historique.`)) return;
  base.maisons = base.maisons.filter(x => x.id !== m.id);
  base.passages = base.passages.filter(p => p.maisonId !== m.id);
  indexer();
  $('dlg-maison').close();
  enregistrer();
  rendreTournee();
}

// ============================================================
// GÉOCODAGE (Base Adresse Nationale)
// ============================================================
async function geocoder(m) {
  const q = [m.numero, m.voie, m.lieu, m.commune].filter(Boolean).join(' ');
  if (q.length < 3) return null;
  const rep = await fetch(`https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&limit=1`);
  if (!rep.ok) throw new Error('Service d\'adresses indisponible');
  const f = (await rep.json()).features?.[0];
  if (!f) return null;
  return { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], score: f.properties.score, label: f.properties.label };
}

async function geocoderMaisonDialogue() {
  const m = { numero: $('m-numero').value, voie: $('m-voie').value, lieu: $('m-lieu').value, commune: $('m-commune').value };
  $('m-gps-resultat').textContent = 'Recherche…';
  try {
    const r = await geocoder(m);
    if (!r) { $('m-gps-resultat').textContent = 'Adresse non trouvée.'; return; }
    gpsDialogue = r;
    $('m-gps').textContent = `Position : ${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}`;
    $('m-gps-resultat').innerHTML = `BAN : <b>${esc(r.label)}</b> (fiabilité ${Math.round(r.score * 100)} %)${r.score < 0.5 ? ' ⚠️ à vérifier' : ''}`;
  } catch (e) {
    $('m-gps-resultat').textContent = '❌ ' + e.message;
  }
}

// ------------------------------------------------------------
// Rues écrites à l'envers : « lacan ( rue jean ) » -> « Rue Jean Lacan »
// ------------------------------------------------------------
function casseTitre(texte) {
  const petits = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'et', 'au', 'aux', 'sur', 'en']);
  return String(texte).toLowerCase().split(/\s+/).filter(Boolean).map((mot, i) =>
    (i && petits.has(mot)) ? mot : mot.replace(/^([dl]')?(.)/, (x, prefixe, lettre) => (prefixe || '') + lettre.toUpperCase())
  ).join(' ');
}

function redresserVoie(voie) {
  const m = String(voie || '').match(/^(.*?)\s*\(\s*(.*?)\s*\)\s*$/);
  if (!m || !m[1] || !m[2]) return null;
  const tete = m[2];
  if (normaliser(tete).includes(normaliser(m[1]))) return casseTitre(tete);   // « mars ( rue du 19 mars 1962 ) »
  const nom = /\s/.test(tete) ? m[1] : m[1].replace(/^rue\s+/i, '');           // « Rue Adolphe Boisse (impasse) »
  return casseTitre(`${tete} ${nom}`);
}

function ruesARedresser() {
  const rues = new Map();
  for (const m of base.maisons) {
    const proposee = redresserVoie(m.voie);
    if (!proposee) continue;
    if (!rues.has(m.voie)) rues.set(m.voie, { voie: m.voie, proposee, nb: 0 });
    rues.get(m.voie).nb++;
  }
  return [...rues.values()].sort((a, b) => b.nb - a.nb);
}

function appliquerRues() {
  let nb = 0;
  document.querySelectorAll('#gps-rues-corps tr[data-voie]').forEach(tr => {
    const proposee = tr.querySelector('[data-rue="proposee"]').value.trim();
    if (!tr.querySelector('[data-rue="coche"]').checked || !proposee) return;
    for (const m of base.maisons) {
      if (m.voie === tr.dataset.voie) { m.voie = proposee; nb++; }
    }
  });
  journaliser('import', `Rues remises à l'endroit : ${nb} maisons`);
  enregistrer();
  rendreGps();
  toast(`✓ ${nb} maisons corrigées`);
}

// ------------------------------------------------------------
// Positions GPS : recherche limitée à la commune de chaque maison
// ------------------------------------------------------------
let gpsPortee = null;      // id de tournée, ou null pour toutes
let gpsEnCours = false;
let gpsArret = false;
let gpsManuels = [];       // placements à la main listés dans la fenêtre

function maisonsGps() {
  return (gpsPortee ? maisonsDe(gpsPortee) : base.maisons).filter(m => m.etat !== 'disparue');
}

function ouvrirGps(tourneeId) {
  gpsPortee = tourneeId;
  const t = tourneeId ? tournee(tourneeId) : null;
  $('gps-titre').textContent = t ? `Positions GPS — ${t.nom}` : 'Rues et positions GPS';
  rendreGps();
  $('dlg-gps').showModal();
}

function rendreGps() {
  const rues = ruesARedresser();
  $('gps-rues-bloc').hidden = rues.length === 0;
  $('gps-etape').textContent = rues.length ? '2. Positions GPS' : 'Positions GPS';
  $('gps-rues-corps').innerHTML = rues.map(r => `<tr data-voie="${esc(r.voie)}">
    <td><input type="checkbox" data-rue="coche" style="width:auto" checked /></td>
    <td class="discret">${esc(r.voie)}</td>
    <td><input data-rue="proposee" value="${esc(r.proposee)}" /></td>
    <td class="num">${r.nb}</td></tr>`).join('');
  rendreResultatsGps();
  rendreManuels();
}

// Placements à la main, regroupés par point, pour pouvoir les annuler
function rendreManuels() {
  const groupes = new Map();
  for (const m of maisonsGps()) {
    if (m.lat == null || ![LIBELLE_GROUPE, LIBELLE_MAISON].includes(m.geoLabel)) continue;
    const k = `${m.geoLabel}|${m.lat.toFixed(5)},${m.lng.toFixed(5)}`;
    if (!groupes.has(k)) groupes.set(k, []);
    groupes.get(k).push(m);
  }
  gpsManuels = [...groupes.values()].sort((a, b) => b.length - a.length);
  $('gps-manuel-bloc').hidden = gpsManuels.length === 0;
  $('gps-manuel-corps').innerHTML = gpsManuels.map((g, i) => {
    const m = g[0], t = tournee(m.tourneeId);
    return `<tr><td>${esc(m.geoLabel === LIBELLE_GROUPE ? (m.lieu || 'Groupe') : adresse(m))}</td><td class="discret">${esc(t ? t.nom : '')}</td>
      <td class="num">${g.length}</td><td class="discret">${g.every(x => x.posAvant) ? 'Position précédente' : 'Recherche BAN à relancer'}</td>
      <td><button type="button" class="btn" data-action="annuler-manuel" data-i="${i}">↩ Annuler</button></td></tr>`;
  }).join('');
}

function annulerManuel(i) {
  const g = gpsManuels[i];
  if (!confirm(`Annuler le placement de ${g.length} maison(s) ?`)) return;
  for (const m of g) {
    Object.assign(m, m.posAvant || { lat: null, lng: null, posApprochee: false, geoNiveau: '', geoLabel: '', geoScore: null });
    delete m.posAvant;
  }
  journaliser('geocodage', `Placement annulé : ${g.length} maison(s)`, g[0].tourneeId);
  enregistrer();
  rendreGps();
  rendreTout();
  toast(g.some(m => m.lat == null) ? '↩ Annulé : relancez « Chercher les positions »' : '↩ Placement annulé');
}

function rendreResultatsGps() {
  const cases = new Map();
  for (const m of maisonsGps()) {
    if (!cases.has(m.tourneeId)) cases.set(m.tourneeId, { numero: 0, approchee: 0, aucune: 0, reste: 0 });
    const c = cases.get(m.tourneeId);
    if (m.lat != null) c[m.posApprochee ? 'approchee' : 'numero']++;
    else if (m.geoNiveau === 'aucun') c.aucune++;
    else c.reste++;
  }
  const lignes = [...cases.entries()].map(([id, c]) => ({ nom: tournee(id) ? tournee(id).nom : '', ...c }))
    .sort((a, b) => normaliser(a.nom).localeCompare(normaliser(b.nom)));
  $('gps-corps').innerHTML = lignes.map(c => `<tr><td>${esc(c.nom)}</td><td class="num">${c.numero}</td><td class="num">${c.approchee}</td><td class="num">${c.aucune}</td><td class="num">${c.reste}</td></tr>`).join('');
  const somme = (k) => lignes.reduce((s, c) => s + c[k], 0);
  if (!gpsEnCours) {
    $('gps-resume').textContent = `✅ ${somme('numero')} au numéro · 🟡 ${somme('approchee')} approchées · 🔴 ${somme('aucune')} non trouvées · ${somme('reste')} à chercher.`;
  }
}

async function appelBan(parametres) {
  for (let essai = 0; essai < 4; essai++) {
    // Un refus pour trop de requêtes peut apparaître comme une erreur réseau : on retente aussi dans ce cas
    const rep = await fetch(`https://api-adresse.data.gouv.fr/search/?${new URLSearchParams(parametres)}`).catch(() => null);
    if (rep && rep.ok) return (await rep.json()).features || [];
    if (rep && rep.status !== 429 && rep.status < 500) break;
    await new Promise(res => setTimeout(res, 1500 * (essai + 1)));   // service saturé : on patiente
  }
  throw new Error('Service d\'adresses indisponible');
}

async function codeCommune(commune, codes) {
  const k = normaliser(commune);
  if (!codes.has(k)) {
    codes.set(k, appelBan({ q: commune, type: 'municipality', limit: 5, lat: BOZOULS.lat, lon: BOZOULS.lng }).then(liste => {
      const f = liste.find(x => memeNom(x.properties.city, commune) && String(x.properties.citycode).startsWith('12'));
      return f ? f.properties.citycode : '';
    }));
  }
  return codes.get(k);
}

function niveauPosition(f, m) {
  const p = f.properties;
  if (p.type === 'housenumber') return parseInt(p.housenumber) === parseInt(m.numero) ? 'numero' : 'rue';
  if (p.type === 'street') return 'rue';
  if (p.type === 'locality') return 'lieu';
  return memeNom(m.lieu || m.commune, p.city) ? 'lieu' : 'aucun';   // le centre d'une commune ne situe pas un hameau
}

async function chercherPosition(m, codes) {
  const code = m.commune ? await codeCommune(m.commune, codes) : '';
  const voie = redresserVoie(m.voie) || m.voie;
  const requetes = [[m.numero, voie || m.lieu].filter(Boolean).join(' ')];
  if ((voie || m.numero) && m.lieu) requetes.push(m.lieu);    // rue ou numéro inconnu : on se rabat sur le hameau
  if (!code && m.commune) requetes[0] += ' ' + m.commune;
  for (const q of requetes) {
    if (q.trim().length < 3) continue;
    const parametres = { q, limit: 1 };
    if (code) parametres.citycode = code;
    const f = (await appelBan(parametres))[0];
    if (!f || f.properties.score < 0.5) continue;
    const niveau = niveauPosition(f, m);
    if (niveau !== 'aucun') return { f, niveau };
  }
  return null;
}

async function lancerGps() {
  const aTraiter = maisonsGps().filter(m => m.lat == null);
  if (!aTraiter.length) { toast('Toutes les maisons ont déjà une position.'); return; }
  gpsEnCours = true;
  gpsArret = false;
  $('btn-lancer-gps').disabled = true;
  $('btn-fermer-gps').disabled = true;
  $('btn-arreter-gps').hidden = false;
  const codes = new Map();
  let suivant = 0, faites = 0, erreurs = 0;
  const travailleur = async () => {
    while (suivant < aTraiter.length && !gpsArret) {
      const m = aTraiter[suivant++];
      try {
        const r = await chercherPosition(m, codes);
        if (r) {
          Object.assign(m, {
            lat: r.f.geometry.coordinates[1], lng: r.f.geometry.coordinates[0], geoScore: r.f.properties.score,
            geoLabel: r.f.properties.label, geoNiveau: r.niveau, posApprochee: r.niveau !== 'numero'
          });
        } else m.geoNiveau = 'aucun';
      } catch (e) {
        erreurs++;
      }
      faites++;
      $('gps-resume').textContent = `🌍 ${faites} / ${aTraiter.length}…`;
      if (faites % 100 === 0) { enregistrer(); rendreResultatsGps(); }
      await new Promise(res => setTimeout(res, 120));   // limite du service : 50 requêtes / seconde
    }
  };
  await Promise.all([travailleur(), travailleur(), travailleur(), travailleur()]);
  gpsEnCours = false;
  $('btn-lancer-gps').disabled = false;
  $('btn-fermer-gps').disabled = false;
  $('btn-arreter-gps').hidden = true;
  journaliser('geocodage', `${faites} maisons traitées${erreurs ? `, ${erreurs} erreurs réseau` : ''}`, gpsPortee);
  enregistrer();
  rendreResultatsGps();
  rendreTout();
  if (erreurs) toast(`⚠️ ${erreurs} recherches n'ont pas abouti : relancez pour les reprendre`);
}

// ============================================================
// CARTE
// ============================================================
function afficherVueTournee(vue) {
  if (placement) terminerPlacement();
  vueTournee = vue;
  document.querySelectorAll('.vue').forEach(b => b.classList.toggle('actif', b.dataset.vue === vue));
  $('vue-tableau').hidden = vue !== 'tableau';
  $('vue-carte').hidden = vue !== 'carte';
  if (vue === 'carte') rendreCarte(true); else rendreMaisons();
}

function rendreCarte(cadrer) {
  if (typeof L === 'undefined') { $('carte').textContent = 'Carte indisponible (pas de connexion).'; return; }
  if (placement) terminerPlacement();
  if (!carte) {
    carte = L.map('carte').setView([44.47, 2.72], 13);
    const plan = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(carte);
    const aerienne = L.tileLayer(URL_VUE_AERIENNE, { maxZoom: 19, attribution: '© IGN' });
    L.control.layers({ 'Plan': plan, 'Vue aérienne': aerienne }, null, { collapsed: false, position: 'bottomleft' }).addTo(carte);
    coucheCarte = L.layerGroup().addTo(carte);
  }
  setTimeout(() => carte.invalidateSize(), 30);
  coucheCarte.clearLayers();
  marqueursMaison.clear();
  const a = base.anneeCourante;
  const points = [];
  // Les maisons placées sur un même point (rue, hameau) sont regroupées sous une pastille numérotée
  const piles = new Map();
  for (const m of trierMaisons(maisonsDe(tourneeActiveId))) {
    if (m.lat == null) continue;
    const k = m.lat.toFixed(5) + ',' + m.lng.toFixed(5);
    if (!piles.has(k)) piles.set(k, []);
    piles.get(k).push(m);
  }
  for (const pile of piles.values()) {
    const { lat, lng } = pile[0];
    let mk;
    if (pile.length === 1) {
      const m = pile[0], p = passage(m.id, a);
      mk = L.circleMarker([lat, lng], { radius: 8, weight: 2, color: '#fff', fillOpacity: m.posApprochee ? .55 : .95, fillColor: COULEURS[p.statut] || COULEURS.autre });
      mk.bindTooltip(`${esc(adresse(m))} — ${esc(m.nom)}<br>${esc(libelleStatut(p))}${p.statut === 'don' ? ' ' + euros(p.don) : ''}`);
      mk.on('click', () => ouvrirDialogueMaison(m.id));
    } else {
      mk = L.marker([lat, lng], { icon: L.divIcon({ className: '', html: `<div class="pile-carte">${pile.length}</div>`, iconSize: [30, 30] }) });
      const mobiles = pile.filter(m => m.posApprochee);
      mk.bindPopup(`<div class="pile-liste"><b>${pile.length} maisons au même point</b>${mobiles.length > 1 ? `<button type="button" class="pile-groupe" data-groupe>📌 Déplacer ce groupe (${mobiles.length})</button>` : ''}${pile.map(m =>
        `<div class="pile-ligne"><button type="button" data-maison="${esc(m.id)}"><span class="pastille" style="background:${COULEURS[passage(m.id, a).statut] || COULEURS.autre}"></span>${esc(adresse(m))} — ${esc(m.nom)}</button><button type="button" data-placer="${esc(m.id)}" title="Placer sur la carte">📌</button></div>`).join('')}</div>`);
      // Leaflet bloque la propagation des clics dans les popups : écouteurs directs
      mk.on('popupopen', (e) => {
        const bulle = e.popup.getElement();
        bulle.querySelectorAll('[data-maison]').forEach(b => {
          b.onclick = () => { carte.closePopup(); ouvrirDialogueMaison(b.dataset.maison); };
        });
        bulle.querySelectorAll('[data-placer]').forEach(b => {
          b.onclick = () => { carte.closePopup(); demarrerPlacement(b.dataset.placer); };
        });
        const boutonGroupe = bulle.querySelector('[data-groupe]');
        if (boutonGroupe) boutonGroupe.onclick = () => {
          carte.closePopup();
          demarrerPlacement(mobiles[0].id, { ids: mobiles.map(m => m.id), titre: mobiles[0].lieu || 'Groupe de maisons' });
        };
      });
    }
    mk.addTo(coucheCarte);
    pile.forEach(m => marqueursMaison.set(m.id, mk));
    points.push([lat, lng]);
  }
  // Sans animation : un zoom en cours ferait ignorer le centrage demandé juste après (📍, 📌)
  if (cadrer && points.length) carte.fitBounds(points, { padding: [30, 30], maxZoom: 17, animate: false });
}

// Placement à la main : un clic sur la carte ou un glisser du repère, puis validation
// Maisons d'un hameau qui peuvent bouger ensemble : les positions déjà exactes ne sont jamais déplacées
function maisonsDuHameau(m) {
  if (!m.lieu) return [];
  return base.maisons.filter(x => x.etat !== 'disparue' && (x.lat == null || x.posApprochee) &&
    normaliser(x.commune) === normaliser(m.commune) && normaliser(x.lieu) === normaliser(m.lieu));
}

// groupe (facultatif) : { ids, titre } pour déplacer plusieurs maisons d'un coup
function demarrerPlacement(id, groupe = null) {
  if (typeof L === 'undefined') { toast('Carte indisponible (pas de connexion).'); return; }
  const m = maison(id);
  document.querySelectorAll('dialog[open]').forEach(d => d.close());
  afficherVueTournee('carte');
  const proches = maisonsDe(m.tourneeId).filter(x => x.lat != null);
  const reference = m.lat != null ? m : (proches.find(x => normaliser(x.lieu) === normaliser(m.lieu)) || proches[0]);
  const depart = reference ? [reference.lat, reference.lng] : carte.getCenter();
  carte.closePopup();
  carte.removeLayer(coucheCarte);
  const repere = L.marker(depart, {
    draggable: true, autoPan: true,
    icon: L.divIcon({ className: 'repere-placement', html: '📌', iconSize: [30, 30], iconAnchor: [15, 30] })
  }).addTo(carte);
  const auClic = (e) => repere.setLatLng(e.latlng);
  carte.on('click', auClic);
  placement = { ids: groupe ? groupe.ids : [id], groupe: !!groupe, repere, auClic };
  $('placement-texte').textContent = groupe
    ? `${groupe.titre} (${groupe.ids.length} maisons) — cliquez à l'endroit voulu ou faites glisser le repère.`
    : `${adresse(m)} — cliquez à l'endroit de la maison ou faites glisser le repère.`;
  $('placement-bandeau').hidden = false;
  setTimeout(() => carte.setView(depart, Math.max(carte.getZoom(), 18)), 80);
}

function terminerPlacement() {
  carte.off('click', placement.auClic);
  carte.removeLayer(placement.repere);
  carte.addLayer(coucheCarte);
  $('placement-bandeau').hidden = true;
  placement = null;
}

function validerPlacement() {
  const { lat, lng } = placement.repere.getLatLng();
  const { ids, groupe } = placement;
  // Un groupe reste « approché » : chaque maison pourra ensuite être ajustée
  const position = groupe
    ? { lat, lng, posApprochee: true, geoNiveau: 'lieu', geoLabel: LIBELLE_GROUPE, geoScore: null }
    : { lat, lng, posApprochee: false, geoNiveau: 'manuel', geoLabel: LIBELLE_MAISON, geoScore: null };
  for (const id of ids) {
    const m = maison(id);
    // On garde la position précédente pour pouvoir annuler (voir « Rues et positions GPS »)
    m.posAvant = { lat: m.lat ?? null, lng: m.lng ?? null, posApprochee: !!m.posApprochee, geoNiveau: m.geoNiveau || '', geoLabel: m.geoLabel || '', geoScore: m.geoScore ?? null };
    Object.assign(m, position);
  }
  ids.forEach(id => selectionPlacement.delete(id));
  terminerPlacement();
  enregistrer();
  rendreCarte(false);
  rendreMaisons();
  rendreChiffresTournee();
  toast(groupe ? `📌 ${ids.length} maisons déplacées` : '📌 Position enregistrée');
}

function voirSurCarte(id) {
  afficherVueTournee('carte');
  const m = maison(id);
  setTimeout(() => {
    const mk = marqueursMaison.get(id);
    if (!mk) return;
    carte.setView([m.lat, m.lng], Math.max(carte.getZoom(), 18));
    if (mk.getPopup()) mk.openPopup(); else mk.openTooltip();
  }, 120);
}

// ============================================================
// FICHIER POUR LE TERRAIN (format §8.3)
// ============================================================
function exporterTerrain() {
  const t = tournee(tourneeActiveId);
  const a = base.anneeCourante;
  const maisons = trierMaisons(maisonsDe(t.id)).filter(m => m.etat !== 'disparue');
  const donnees = {
    format: FORMAT_TOURNEE,
    version: 1,
    exporteLe: maintenant(),
    tournee: { id: t.id, nom: t.nom, annee: a, responsable: t.responsable || '' },
    maisons: maisons.map(m => {
      const p = passage(m.id, a);
      return {
        id: m.id, commune: m.commune, lieu: m.lieu, ordreLieu: m.ordreLieu, numero: m.numero, voie: m.voie, ordreRue: m.ordreRue,
        nom: m.nom, etat: m.etat, lat: m.lat, lng: m.lng, infos: m.infos,
        voisineId: m.voisineId || '', cote: m.cote || 'apres', posApprochee: !!m.posApprochee, creeLe: m.creeLe || '',
        historique: base.passages
          .filter(x => x.maisonId === m.id && x.annee < a && x.annee >= a - NB_ANNEES_HISTORIQUE && x.statut !== 'a_visiter')
          .sort((x, y) => y.annee - x.annee)
          .map(x => ({ annee: x.annee, statut: x.statut, don: x.don })),
        passage: { statut: p.statut, don: p.don, remarque: p.remarque || '', modifieLe: p.modifieLe || null }
      };
    })
  };
  telecharger(JSON.stringify(donnees), `tournee_${nomFichierSur(t.nom)}_${a}.json`, 'application/json');
  journaliser('envoi', `Fichier terrain (${maisons.length} maisons)`, t.id, a);
  enregistrer();
  alert(`📤 Fichier « tournee_${nomFichierSur(t.nom)}_${a}.json » enregistré dans vos Téléchargements.\n\nEnvoyez-le au bénévole par WhatsApp Web ou par mail.`);
}

// ============================================================
// IMPORT D'UN RETOUR (aperçu puis intégration)
// ============================================================
function decrire(p, etat, nom, lieuAdresse, infos) {
  const morceaux = [libelleStatut(p)];
  if (p.statut === 'don') morceaux[0] += ' ' + euros(p.don);
  if (lieuAdresse) morceaux.push('Adresse : ' + lieuAdresse);
  if (infos) morceaux.push('Infos : ' + infos);
  if (p.remarque) morceaux.push('« ' + p.remarque + ' »');
  if (etat) morceaux.push(ETATS[etat] || etat);
  if (nom) morceaux.push('Habitant : ' + nom);
  return morceaux.join(' · ');
}

async function lireRetour(f) {
  let retour;
  try {
    retour = JSON.parse(await lireFichierTexte(f));
  } catch (e) {
    alert('❌ Fichier illisible.');
    return;
  }
  if (!retour || retour.format !== FORMAT_RETOUR) { alert('❌ Ce fichier n\'est pas un retour de tournée.'); return; }
  const t = tournee(retour.tourneeId);
  if (!t) { alert('❌ Ce retour concerne une tournée inconnue dans cette base.'); return; }
  const a = Number(retour.annee) || base.anneeCourante;

  const lignes = [];
  let aJour = 0;
  for (const r of retour.maisons || []) {
    const m = maison(r.id);
    if (!m) { lignes.push({ type: 'inconnue', r, coche: false }); continue; }
    const avant = passage(m.id, a);
    const apres = r.passage || {};
    const changeNom = r.nom != null && r.nom !== m.nom;
    const changeEtat = r.etat && r.etat !== m.etat;
    const changeGps = r.lat != null && (m.lat == null || Math.abs(r.lat - m.lat) > 1e-6 || Math.abs(r.lng - m.lng) > 1e-6);
    const changePassage = apres.statut !== avant.statut || (apres.don || 0) !== (avant.don || 0) || (apres.remarque || '') !== (avant.remarque || '');
    // Absent des retours envoyés par les versions terrain antérieures à 0.2.0
    const changeAdresse = r.voie !== undefined && (r.numero !== (m.numero || '') || r.voie !== (m.voie || '') || r.lieu !== (m.lieu || ''));
    const changeInfos = r.infos !== undefined && r.infos !== (m.infos || '');
    if (!changeNom && !changeEtat && !changeGps && !changePassage && !changeAdresse && !changeInfos) { aJour++; continue; }
    const pcPlusRecent = avant.modifieLe && apres.modifieLe && avant.modifieLe > apres.modifieLe;
    lignes.push({ type: 'maison', r, m, avant, apres, changeNom, changeEtat, changeGps, changePassage, changeAdresse, changeInfos, pcPlusRecent, coche: !pcPlusRecent });
  }
  for (const n of retour.nouvelles || []) {
    if (maison(n.id)) { aJour++; continue; }   // déjà intégrée lors d'un précédent retour
    lignes.push({ type: 'nouvelle', r: n, coche: true });
  }

  retourEnCours = { retour, annee: a, lignes };
  const dejaImporte = base.journal.find(j => j.type === 'retour' && j.detail && j.detail.envoyeLe === retour.envoyeLe && j.tourneeId === t.id);
  $('retour-resume').textContent = `« ${t.nom} » — campagne ${a} — ${retour.benevole || 'bénévole inconnu'} — envoyé le ${dateCourte(retour.envoyeLe)}. ` +
    `${lignes.length} changement(s)${aJour ? `, ${aJour} maison(s) déjà à jour` : ''}.`;
  const alertes = [];
  if (dejaImporte) alertes.push(`Ce retour a déjà été importé le ${dateCourte(dejaImporte.le)}.`);
  if (a !== base.anneeCourante) alertes.push(`Attention : ce retour concerne la campagne ${a}, pas ${base.anneeCourante}.`);
  if (lignes.some(l => l.pcPlusRecent)) alertes.push('Certaines maisons ont été modifiées sur le PC après la saisie terrain : elles sont décochées.');
  $('retour-alerte').innerHTML = alertes.map(esc).join('<br>');
  $('retour-alerte').hidden = alertes.length === 0;

  $('retour-corps').innerHTML = lignes.map((l, i) => {
    if (l.type === 'inconnue') return `<tr><td></td><td colspan="3" class="discret">Maison inconnue (supprimée sur le PC ?) — ignorée</td></tr>`;
    if (l.type === 'nouvelle') {
      const n = l.r;
      return `<tr><td><input type="checkbox" data-ligne="${i}" checked /></td>
        <td>🆕 <b>${esc(adresse(n))}</b>${n.lieu ? ' — ' + esc(n.lieu) : ''}${n.lat != null ? ' 📍' : ''}</td>
        <td class="discret">Nouvelle maison</td><td>${esc(decrire(n.passage || {}, n.etat !== 'habitee' ? n.etat : null, n.nom))}</td></tr>`;
    }
    return `<tr><td><input type="checkbox" data-ligne="${i}" ${l.coche ? 'checked' : ''} /></td>
      <td><b>${esc(adresse(l.m))}</b><div class="discret">${esc(l.m.nom)}</div></td>
      <td class="discret">${esc(decrire(l.avant, l.changeEtat ? l.m.etat : null, l.changeNom ? l.m.nom || '—' : null, l.changeAdresse ? [l.m.numero, l.m.voie, l.m.lieu].filter(Boolean).join(' ') || '—' : null, l.changeInfos ? l.m.infos || '—' : null))}${l.pcPlusRecent ? '<br>⚠️ modifié sur le PC le ' + dateCourte(l.avant.modifieLe) : ''}</td>
      <td>${esc(decrire(l.apres, l.changeEtat ? l.r.etat : null, l.changeNom ? l.r.nom || '—' : null, l.changeAdresse ? [l.r.numero, l.r.voie, l.r.lieu].filter(Boolean).join(' ') || '—' : null, l.changeInfos ? l.r.infos || '—' : null))}${l.changeGps ? ' · 📍 position' : ''}</td></tr>`;
  }).join('') || '<tr><td colspan="4" class="vide">Rien de nouveau dans ce retour.</td></tr>';
  $('retour-tout').checked = lignes.every(l => l.coche || l.type === 'inconnue');
  $('dlg-retour').showModal();
}

function appliquerRetour() {
  const { retour, annee, lignes } = retourEnCours;
  const coches = new Set([...document.querySelectorAll('#retour-corps input[data-ligne]:checked')].map(c => Number(c.dataset.ligne)));
  let nbMaj = 0, nbNouvelles = 0;
  lignes.forEach((l, i) => {
    if (!coches.has(i)) return;
    if (l.type === 'maison') {
      if (l.changePassage) {
        const p = ecrirePassage(l.m.id, annee, { ...l.apres, source: 'terrain', benevole: retour.benevole || '' });
        p.modifieLe = l.apres.modifieLe || maintenant();
      }
      if (l.changeNom) l.m.nom = l.r.nom;
      if (l.changeEtat) l.m.etat = l.r.etat;
      if (l.changeGps) { l.m.lat = l.r.lat; l.m.lng = l.r.lng; l.m.geoLabel = 'Relevé sur le terrain'; l.m.posApprochee = !!l.r.posApprochee; }
      if (l.changeAdresse) { l.m.numero = l.r.numero; l.m.voie = l.r.voie; l.m.lieu = l.r.lieu; }
      if (l.changeInfos) l.m.infos = l.r.infos;
      nbMaj++;
    } else if (l.type === 'nouvelle') {
      const n = l.r;
      base.maisons.push({
        id: n.id, tourneeId: retour.tourneeId, commune: n.commune || '', lieu: n.lieu || '',
        ordreLieu: Number(n.ordreLieu) || 0, numero: n.numero || '', voie: n.voie || '', ordreRue: Number(n.ordreRue) || 0,
        nom: n.nom || '', etat: n.etat || 'habitee', lat: n.lat ?? null, lng: n.lng ?? null, infos: n.infos || '',
        nouvelle: true, refExterne: '', creeLe: n.creeLe || maintenant(),
        voisineId: n.voisineId || '', cote: n.cote || 'apres', posApprochee: !!n.posApprochee
      });
      if (n.passage) {
        const p = ecrirePassage(n.id, annee, { ...n.passage, source: 'terrain', benevole: retour.benevole || '' });
        p.modifieLe = n.passage.modifieLe || maintenant();
      }
      nbNouvelles++;
    }
  });
  // Les changements du terrain sont gardés même pour les lignes décochées : ils ont bien eu lieu
  for (const r of [...(retour.maisons || []), ...(retour.nouvelles || [])]) {
    if (!maison(r.id)) continue;
    const changements = r.changements || (r.passage && r.passage.modifieLe && r.passage.statut !== 'a_visiter' ? [r.passage] : []);
    for (const c of changements) {
      noterHistorique({ maisonId: r.id, annee, le: c.le || c.modifieLe, statut: c.statut, don: c.don || 0, mode: '', qui: retour.benevole || '', source: 'terrain' });
    }
  }
  journaliser('retour', { envoyeLe: retour.envoyeLe, benevole: retour.benevole, maj: nbMaj, nouvelles: nbNouvelles }, retour.tourneeId, annee);
  $('dlg-retour').close();
  retourEnCours = null;
  tourneeActiveId = retour.tourneeId;
  ecranActif = 'tournee';
  enregistrer();
  rendreTout();
  toast(`✓ Retour intégré : ${nbMaj} maison(s) mise(s) à jour, ${nbNouvelles} nouvelle(s)`);
}

// ============================================================
// IMPRESSION (feuille de secours) ET CSV
// ============================================================
function imprimer() {
  const t = tournee(tourneeActiveId);
  const a = base.anneeCourante;
  let html = `<h1>${esc(t.nom)} — campagne ${a}</h1><p>${esc(t.responsable ? 'Responsable : ' + t.responsable : '')} · imprimé le ${new Date().toLocaleDateString('fr-FR')}</p>
    <table><thead><tr><th>N°</th><th>Voie</th><th>Habitant</th><th>Infos</th><th>${a - 1}</th><th class="case">Statut</th><th class="case">Don</th><th>Remarque</th></tr></thead><tbody>`;
  let groupe = null;
  for (const m of trierMaisons(maisonsDe(t.id)).filter(estConcernee)) {
    const g = [m.commune, m.lieu].filter(Boolean).join(' — ') || 'Sans lieu-dit';
    if (g !== groupe) { html += `<tr class="groupe"><td colspan="8">${esc(g)}</td></tr>`; groupe = g; }
    html += `<tr><td>${esc(m.numero)}</td><td>${esc(m.voie)}</td><td>${esc(m.nom)}</td><td>${esc(m.infos)}</td>
      <td>${esc(texteHistorique(passage(m.id, a - 1)))}</td><td></td><td></td><td></td></tr>`;
  }
  $('zone-impression').innerHTML = html + '</tbody></table>';
  window.print();
}

function exporterCsv() {
  const a = base.anneeCourante;
  const enTete = ['Tournée', 'Commune', 'Lieu-dit', 'N°', 'Voie', 'Habitant', 'État', 'Calendriers', `Statut ${a}`, `Don ${a}`, `Remarque ${a}`, `Don ${a - 1}`, 'Saisi par', 'Latitude', 'Longitude'];
  const lignes = [enTete];
  for (const t of base.tournees) {
    for (const m of trierMaisons(maisonsDe(t.id))) {
      const p = passage(m.id, a), p1 = passage(m.id, a - 1);
      lignes.push([t.nom, m.commune, m.lieu, m.numero, m.voie, m.nom, ETATS[m.etat] || m.etat, m.nbCalendriers ?? 1, libelleStatut(p),
        p.statut === 'don' ? String(p.don).replace('.', ',') : '', p.remarque || '',
        p1.statut === 'don' ? String(p1.don).replace('.', ',') : '', p.benevole || '', m.lat ?? '', m.lng ?? '']);
    }
  }
  const csv = lignes.map(l => l.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
  telecharger('﻿' + csv, `tournees_${a}.csv`, 'text/csv;charset=utf-8');
}

// ============================================================
// IMPORT D'UNE SAUVEGARDE DE L'ANCIENNE APPLICATION (V1)
// ============================================================
function convertirV1(etatV1) {
  if (!etatV1 || !Array.isArray(etatV1.tournees)) throw new Error('Ce fichier n\'est pas une sauvegarde de l\'ancienne application.');
  const b = nouvelleBase();
  const groupes = new Map();   // nom de base -> { tournee, maisons: Map(clé adresse -> maison) }
  let anneeMax = 0;

  const tourneesV1 = etatV1.tournees.map(t => ({
    ...t,
    _annee: parseInt(t.annee) || (t.date ? new Date(t.date).getFullYear() : new Date().getFullYear())
  })).sort((x, y) => x._annee - y._annee);

  for (const tv1 of tourneesV1) {
    const annee = tv1._annee;
    anneeMax = Math.max(anneeMax, annee);
    const nomBase = String(tv1.nom || 'Sans nom').replace(/(\s*\((\d{4}|Import)\))+\s*$/i, '').trim();
    if (!groupes.has(nomBase)) {
      const t = { id: uid('t-'), nom: nomBase, responsable: tv1.responsable || '', secteur: tv1.secteur || '', ordre: groupes.size + 1 };
      b.tournees.push(t);
      groupes.set(nomBase, { tournee: t, maisons: new Map() });
    }
    const g = groupes.get(nomBase);
    if (tv1.responsable) g.tournee.responsable = tv1.responsable;

    for (const mv1 of tv1.maisons || []) {
      const voie = mv1.adresse || '';
      let cleAdresse = [mv1.commune, mv1.lieu, mv1.numero, voie].map(normaliser).join('|');
      if (!normaliser(voie) && !normaliser(mv1.numero)) cleAdresse += '|' + normaliser(mv1.nom);
      let m = g.maisons.get(cleAdresse);
      if (!m) {
        m = { id: uid('m-'), tourneeId: g.tournee.id, etat: 'habitee', nouvelle: false, refExterne: 'v1:' + mv1.id, creeLe: maintenant(), lat: null, lng: null, infos: '' };
        b.maisons.push(m);
        g.maisons.set(cleAdresse, m);
      }
      // Les infos de l'année la plus récente l'emportent
      Object.assign(m, {
        commune: mv1.commune || m.commune || '', lieu: mv1.lieu || m.lieu || '',
        ordreLieu: parseInt(mv1.ordreLieu) || m.ordreLieu || 0, numero: mv1.numero != null ? String(mv1.numero) : (m.numero || ''),
        voie: voie || m.voie || '', ordreRue: parseInt(mv1.ordreRue) || m.ordreRue || 0, nom: mv1.nom || m.nom || ''
      });
      if (typeof mv1.lat === 'number' && typeof mv1.lng === 'number') { m.lat = mv1.lat; m.lng = mv1.lng; }

      // Statut V1 -> état de maison ou passage V2
      let statut = mv1.statut || 'don';
      const don = lireMontant(mv1.don);
      if (statut === 'secondaire') { m.etat = 'secondaire'; statut = 'autre'; }
      if (statut === 'inhabite') { m.etat = 'inhabitee'; statut = 'autre'; }
      if (statut === 'don' && don === 0) statut = 'a_visiter';   // V1 : « don » était la valeur par défaut
      if (statut !== 'a_visiter' || mv1.remarque) {
        b.passages.push({ maisonId: m.id, annee, statut, don: statut === 'don' ? don : 0, remarque: mv1.remarque || '', modifieLe: null, source: 'import-v1', benevole: '' });
      }
      const donNm1 = lireMontant(mv1.donNm1);
      if (donNm1 > 0 && !b.passages.some(p => p.maisonId === m.id && p.annee === annee - 1)) {
        b.passages.push({ maisonId: m.id, annee: annee - 1, statut: 'don', don: donNm1, remarque: '', modifieLe: null, source: 'import-v1', benevole: '' });
      }
    }
  }
  // Dédoublonnage des passages (même maison, même année) : le dernier lu gagne
  const uniques = new Map();
  b.passages.forEach(p => uniques.set(cle(p.maisonId, p.annee), p));
  b.passages = [...uniques.values()];
  b.anneeCourante = anneeMax || b.anneeCourante;
  b.journal.push({ le: maintenant(), type: 'import', tourneeId: null, annee: null,
    detail: `Import ancienne application : ${etatV1.tournees.length} tournées V1 → ${b.tournees.length} tournées, ${b.maisons.length} maisons` });
  return b;
}

async function importerV1(f) {
  try {
    const nouvelle = convertirV1(JSON.parse(await lireFichierTexte(f)));
    if (!(await confirmerRemplacement())) return;
    await chargerBase(nouvelle, null);
    alert(`✅ Import terminé : ${nouvelle.tournees.length} tournée(s), ${nouvelle.maisons.length} maison(s), ${nouvelle.passages.length} passage(s).\n\nChoisissez maintenant le fichier où enregistrer cette base (bandeau orange).`);
  } catch (e) {
    alert('❌ ' + (e instanceof SyntaxError ? 'Fichier illisible.' : e.message));
  }
}

// ============================================================
// IMPORT DE LA LISTE ACCESS (export Excel .xlsx, voir SPEC.md §8.4quater)
// ============================================================
const NB_ANNEES_IMPORT = 5;
const NOM_PROVISOIRE = /^Tournée \d+$/;
let accessEnCours = null;

// Un .xlsx est une archive zip de fichiers XML : lecture sans bibliothèque, rien ne quitte le PC
async function lireZip(tampon) {
  const vue = new DataView(tampon);
  let fin = tampon.byteLength - 22;
  while (fin >= 0 && vue.getUint32(fin, true) !== 0x06054b50) fin--;
  if (fin < 0) throw new Error('Ce fichier n\'est pas un classeur Excel (.xlsx).');
  const decodeur = new TextDecoder();
  const entrees = new Map();
  let pos = vue.getUint32(fin + 16, true);
  for (let i = 0, nb = vue.getUint16(fin + 10, true); i < nb; i++) {
    const lgNom = vue.getUint16(pos + 28, true);
    entrees.set(decodeur.decode(new Uint8Array(tampon, pos + 46, lgNom)), {
      methode: vue.getUint16(pos + 10, true),
      taille: vue.getUint32(pos + 20, true),
      local: vue.getUint32(pos + 42, true)
    });
    pos += 46 + lgNom + vue.getUint16(pos + 30, true) + vue.getUint16(pos + 32, true);
  }
  return async (nom) => {
    const e = entrees.get(nom);
    if (!e) return null;
    const debut = e.local + 30 + vue.getUint16(e.local + 26, true) + vue.getUint16(e.local + 28, true);
    const octets = new Uint8Array(tampon, debut, e.taille);
    if (e.methode === 0) return decodeur.decode(octets);
    const flux = new Blob([octets]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return decodeur.decode(await new Response(flux).arrayBuffer());
  };
}

function colonneExcel(reference) {
  let n = 0;
  for (const c of reference.match(/^[A-Z]+/)[0]) n = n * 26 + c.charCodeAt(0) - 64;
  return n - 1;
}

async function lireXlsx(f) {
  const lire = await lireZip(await f.arrayBuffer());
  const xml = async (nom) => {
    const texte = await lire(nom);
    return texte ? new DOMParser().parseFromString(texte, 'application/xml') : null;
  };
  const classeur = await xml('xl/workbook.xml');
  const rels = await xml('xl/_rels/workbook.xml.rels');
  if (!classeur || !rels) throw new Error('Ce fichier n\'est pas un classeur Excel (.xlsx).');

  const partages = [];
  const ss = await xml('xl/sharedStrings.xml');
  if (ss) {
    for (const si of ss.getElementsByTagName('si')) {
      partages.push([...si.getElementsByTagName('t')].filter(t => t.parentNode.nodeName !== 'rPh').map(t => t.textContent).join(''));
    }
  }
  const rid = classeur.getElementsByTagName('sheet')[0].getAttribute('r:id');
  const cible = [...rels.getElementsByTagName('Relationship')].find(r => r.getAttribute('Id') === rid).getAttribute('Target').replace(/^\//, '');
  const feuille = await xml(cible.startsWith('xl/') ? cible : 'xl/' + cible);

  const lignes = [];
  for (const row of feuille.getElementsByTagName('row')) {
    const ligne = [];
    for (const c of row.getElementsByTagName('c')) {
      const type = c.getAttribute('t');
      const v = c.getElementsByTagName('v')[0];
      let valeur = null;
      if (type === 'inlineStr') valeur = [...c.getElementsByTagName('t')].map(t => t.textContent).join('');
      else if (v && type === 's') valeur = partages[Number(v.textContent)];
      else if (v && type) valeur = v.textContent;
      else if (v) valeur = Number(v.textContent);
      ligne[colonneExcel(c.getAttribute('r'))] = valeur;
    }
    lignes.push(ligne);
  }
  return lignes;
}

function analyserAccess(lignes) {
  const entete = (lignes[0] || []).map(c => normaliser(c).replace(/\s/g, ''));
  const colonne = (nom) => entete.indexOf(nom);
  const c = {
    ref: colonne('refadresse'), tournee: colonne('reftournee'), ville: colonne('ville'), numero: colonne('numero'),
    a1: colonne('adresse1'), a2: colonne('adresse2'), loc: colonne('localisation'), nom: colonne('nomfamille'),
    rem: colonne('remarques'), nb: colonne('nbrecalendrier'), ordre: colonne('ordredepassage'), sec: colonne('maisonsecondaire')
  };
  const manquantes = ['ref', 'tournee', 'ville', 'a1', 'nom'].filter(k => c[k] < 0);
  if (manquantes.length) throw new Error('Colonnes attendues introuvables. Ce fichier n\'est pas la liste Access.');

  const texte = (ligne, i) => (i < 0 || ligne[i] == null) ? '' : String(ligne[i]).trim();
  const donnees = lignes.slice(1);
  const annees = entete
    .map((nom, i) => ({ annee: Number((nom.match(/^don(\d{4})$/) || [])[1]), i }))
    .filter(a => a.annee && donnees.some(l => l[a.i] != null && l[a.i] !== ''))
    .sort((x, y) => y.annee - x.annee)
    .slice(0, NB_ANNEES_IMPORT);

  const maisons = [], passages = [], calendriers = [], tournees = new Map();
  let ignorees = 0, deja = 0;
  for (const l of donnees) {
    const ref = texte(l, c.ref), refTournee = texte(l, c.tournee), ville = texte(l, c.ville), a1 = texte(l, c.a1);
    if (!ref || !refTournee || (!ville && !a1)) { ignorees++; continue; }
    const id = 'access-' + ref;
    if (!tournees.has(refTournee)) tournees.set(refTournee, { ref: refTournee, nb: 0, nouvelles: 0, secondaires: 0 });
    const t = tournees.get(refTournee);
    const secondaire = ['1', '-1', 'vrai', 'true'].includes(normaliser(texte(l, c.sec)));
    t.nb++;
    if (secondaire) t.secondaires++;
    const nb = Number(texte(l, c.nb)) || 1;
    const existante = maison(id);
    if (existante) {
      deja++;
      if (existante.nbCalendriers == null) calendriers.push({ id, nb });   // maison importée avant le suivi des calendriers
    } else {
      t.nouvelles++;
      maisons.push({
        id, refTournee, commune: '', lieu: ville, villeSource: ville, ordreLieu: Number(texte(l, c.ordre)) || 999,
        numero: texte(l, c.numero), voie: normaliser(a1) === normaliser(ville) ? '' : a1, ordreRue: 0,
        nom: texte(l, c.nom), etat: secondaire ? 'secondaire' : 'habitee', lat: null, lng: null,
        infos: [texte(l, c.loc), texte(l, c.a2), texte(l, c.rem)].filter(Boolean).join(' — '),
        nbCalendriers: nb, nouvelle: false, refExterne: 'access:' + ref, creeLe: maintenant()
      });
    }
    for (const a of annees) {
      if (indexPassages.has(cle(id, a.annee))) continue;
      // Dans Access, 0 et case vide ont le même sens : pas de don cette année-là
      const don = lireMontant(l[a.i]);
      passages.push({ maisonId: id, annee: a.annee, statut: don > 0 ? 'don' : 'sans_don', don, remarque: '', modifieLe: null, source: 'import-access', benevole: '' });
    }
  }
  return { annees: annees.map(a => a.annee), maisons, passages, calendriers, tournees: [...tournees.values()], ignorees, deja, total: donnees.length };
}

// Table des tournées (RéfTournée, NomTournée) : numéro -> nom
function lireNomsTournees(lignes) {
  const entete = (lignes[0] || []).map(c => normaliser(c).replace(/\s/g, ''));
  const iRef = entete.indexOf('reftournee'), iNom = entete.indexOf('nomtournee');
  if (iRef < 0 || iNom < 0) return null;
  const noms = new Map();
  for (const l of lignes.slice(1)) {
    if (l[iRef] != null && l[iNom]) noms.set(String(l[iRef]).trim(), String(l[iNom]).trim());
  }
  return noms;
}

// Donne leur vrai nom aux tournées encore provisoires ; un nom modifié à la main est conservé
function nommerTourneesAccess(noms) {
  let nb = 0;
  for (const t of base.tournees) {
    const ref = String(t.refExterne || '').replace(/^access:/, '');
    if (NOM_PROVISOIRE.test(t.nom) && noms.has(ref)) { t.nom = noms.get(ref); nb++; }
  }
  return nb;
}

async function preparerAccess(fichiers) {
  try {
    const classeurs = await Promise.all([...fichiers].map(lireXlsx));
    const noms = classeurs.map(lireNomsTournees).find(Boolean) || new Map();
    const liste = classeurs.find(l => !lireNomsTournees(l));
    if (!liste) {
      const nb = nommerTourneesAccess(noms);
      enregistrer();
      rendreTout();
      toast(`✓ ${nb} tournée(s) renommée(s)`);
      return;
    }
    const a = analyserAccess(liste);
    a.noms = noms;
    accessEnCours = a;
    $('access-resume').textContent = `${a.total} lignes · ${a.tournees.length} tournées · ${a.maisons.length} maisons à ajouter · ` +
      `${a.passages.length} passages sur ${a.annees.slice().reverse().join(', ') || 'aucune année'}.`;
    const alertes = [];
    if (a.deja) alertes.push(`${a.deja} maison(s) déjà présente(s) : seuls leurs passages manquants seront ajoutés.`);
    if (a.ignorees) alertes.push(`${a.ignorees} ligne(s) sans tournée ou sans adresse seront ignorées.`);
    $('access-alerte').textContent = alertes.join(' ');
    $('access-alerte').hidden = alertes.length === 0;
    $('access-corps').innerHTML = a.tournees.sort((x, y) => Number(x.ref) - Number(y.ref)).map(t =>
      `<tr><td>${esc(nomTourneeAccess(t.ref, noms))}</td><td class="num">${t.nb}</td><td class="num">${t.nouvelles}</td><td class="num">${t.secondaires}</td></tr>`
    ).join('');
    $('dlg-access').showModal();
  } catch (e) {
    alert('❌ ' + e.message);
  }
}

function tourneeAccess(ref) {
  return base.tournees.find(t => t.refExterne === 'access:' + ref);
}

function nomTourneeAccess(ref, noms) {
  const t = tourneeAccess(ref);
  if (t && !NOM_PROVISOIRE.test(t.nom)) return t.nom;
  return noms.get(ref) || `Tournée ${ref}`;
}

function appliquerAccess() {
  const a = accessEnCours;
  for (const t of a.tournees) {
    if (!tourneeAccess(t.ref)) {
      base.tournees.push({ id: uid('t-'), nom: a.noms.get(t.ref) || `Tournée ${t.ref}`, responsable: '', secteur: '', ordre: Number(t.ref) || 0, refExterne: 'access:' + t.ref });
    }
  }
  nommerTourneesAccess(a.noms);
  for (const { refTournee, ...m } of a.maisons) base.maisons.push({ ...m, tourneeId: tourneeAccess(refTournee).id });
  base.passages.push(...a.passages);
  for (const { id, nb } of a.calendriers) {
    const m = maison(id);
    m.nbCalendriers = nb;
    // Retire la mention posée par la version 0.2.0 de l'import (une vraie remarque reste intacte si nb = 1)
    if (nb > 1) m.infos = (m.infos || '').replace(new RegExp(`( — )?${nb} calendriers$`), '');
  }
  indexer();
  journaliser('import', `Liste Access : ${a.maisons.length} maisons, ${a.passages.length} passages (${a.annees.slice().reverse().join(', ')})`);
  accessEnCours = null;
  $('dlg-access').close();
  if (!tourneeActiveId && base.tournees[0]) tourneeActiveId = base.tournees[0].id;
  enregistrer();
  rendreTout();
  toast('✓ Liste Access importée');
}

// ============================================================
// COMMUNES ET HAMEAUX (valeurs de la colonne « Ville » d'Access)
// ============================================================
const BOZOULS = { lat: 44.4717, lng: 2.7203 };
const RAYON_COMMUNES_KM = 16;   // écarte les homonymes éloignés dans le département
let lieuxEnCours = [];

function memeNom(a, b) {
  const simple = (t) => normaliser(t).replace(/[-']/g, ' ');
  return simple(a) === simple(b);
}

function groupesLieux() {
  const groupes = new Map();
  for (const m of base.maisons) {
    if (!String(m.refExterne || '').startsWith('access:')) continue;
    if (m.villeSource == null) m.villeSource = m.lieu;   // maison importée avant la version 0.3.0
    const k = normaliser(m.villeSource);
    if (!groupes.has(k)) groupes.set(k, { ville: m.villeSource, maisons: [] });
    groupes.get(k).maisons.push(m);
  }
  return [...groupes.values()].sort((x, y) => y.maisons.length - x.maisons.length).map(g => {
    const commune = g.maisons[0].commune || '';
    const avecVoie = g.maisons.find(m => m.voie);
    return {
      ...g,
      commune,
      lieu: !commune ? g.ville : (avecVoie ? avecVoie.lieu : g.maisons[0].lieu),
      tourneeId: g.maisons[0].tourneeId,
      etat: commune ? '✅' : ''
    };
  });
}

function ouvrirLieux() {
  lieuxEnCours = groupesLieux();
  if (!lieuxEnCours.length) { alert('Importez d\'abord la liste Access.'); return; }
  rendreLieux();
  $('dlg-lieux').showModal();
}

function rendreLieux() {
  const sansCommune = lieuxEnCours.filter(g => !g.commune).length;
  $('lieux-resume').textContent = `${lieuxEnCours.length} valeurs · ${sansCommune} sans commune.`;
  $('lieux-corps').innerHTML = lieuxEnCours.map((g, i) => {
    const t = tournee(g.tourneeId);
    return `<tr data-ligne="${i}">
      <td><b>${esc(g.ville || '(vide)')}</b></td>
      <td class="num">${g.maisons.length}</td>
      <td class="discret">${esc(t ? t.nom : '')}</td>
      <td><input data-lieu="commune" value="${esc(g.commune)}" placeholder="Commune" /></td>
      <td><input data-lieu="lieu" value="${esc(g.lieu)}" placeholder="(aucun)" /></td>
      <td title="✅ nom exact · 🟡 à vérifier · 🔴 non trouvée">${g.etat}</td>
    </tr>`;
  }).join('');
}

function lireSaisieLieux() {
  document.querySelectorAll('#lieux-corps tr[data-ligne]').forEach(tr => {
    const g = lieuxEnCours[Number(tr.dataset.ligne)];
    g.commune = tr.querySelector('[data-lieu="commune"]').value.trim();
    g.lieu = tr.querySelector('[data-lieu="lieu"]').value.trim();
  });
}

function distanceKm(lat, lng) {
  const dx = (lng - BOZOULS.lng) * 111.32 * Math.cos(BOZOULS.lat * Math.PI / 180);
  const dy = (lat - BOZOULS.lat) * 110.57;
  return Math.hypot(dx, dy);
}

// Seul le nom du lieu est envoyé à la BAN, jamais celui des habitants
async function chercherCommune(ville) {
  const rep = await fetch(`https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(ville)}&limit=10&lat=${BOZOULS.lat}&lon=${BOZOULS.lng}`);
  if (!rep.ok) throw new Error('Service d\'adresses indisponible');
  const proches = ((await rep.json()).features || []).filter(f =>
    String(f.properties.citycode).startsWith('12') &&
    distanceKm(f.geometry.coordinates[1], f.geometry.coordinates[0]) <= RAYON_COMMUNES_KM);
  const approchee = proches.find(f => f.properties.score >= 0.6);
  return {
    exactes: [...new Set(proches.filter(f => memeNom(f.properties.name, ville) || memeNom(f.properties.city, ville)).map(f => f.properties.city))],
    approchee: approchee ? approchee.properties.city : ''
  };
}

// La commune la plus représentée parmi les noms exacts d'une tournée sert à départager les homonymes
function communeDominante(reponses, tourneeId) {
  const compte = new Map();
  for (const [g, r] of reponses) {
    if (g.tourneeId === tourneeId && r.exactes[0]) compte.set(r.exactes[0], (compte.get(r.exactes[0]) || 0) + g.maisons.length);
  }
  return ([...compte.entries()].sort((a, b) => b[1] - a[1])[0] || [''])[0];
}

async function proposerCommunes() {
  lireSaisieLieux();
  const aTraiter = lieuxEnCours.filter(g => !g.commune && g.ville);
  const reponses = new Map();
  const bouton = $('btn-proposer-communes');
  bouton.disabled = true;
  try {
    for (const [i, g] of aTraiter.entries()) {
      bouton.textContent = `🌍 ${i + 1} / ${aTraiter.length}…`;
      reponses.set(g, await chercherCommune(g.ville).catch(() => ({ exactes: [], approchee: '' })));
      await new Promise(res => setTimeout(res, 60));
    }
    for (const [g, r] of reponses) {
      const dominante = communeDominante(reponses, g.tourneeId);
      if (r.exactes.some(c => memeNom(c, g.ville)) || (dominante && r.exactes.includes(dominante))) {
        Object.assign(g, { commune: r.exactes.find(c => memeNom(c, g.ville)) || dominante, etat: '✅' });
      } else {
        const commune = r.exactes[0] || dominante || r.approchee;
        Object.assign(g, commune ? { commune, etat: '🟡' } : { etat: '🔴' });
      }
      if (g.commune && memeNom(g.commune, g.ville)) g.lieu = '';
    }
  } finally {
    bouton.disabled = false;
    bouton.textContent = '🌍 Proposer les communes manquantes';
  }
  rendreLieux();
}

function enregistrerLieux() {
  lireSaisieLieux();
  let nb = 0;
  for (const g of lieuxEnCours) {
    if (!g.commune) continue;
    for (const m of g.maisons) {
      m.commune = g.commune;
      m.lieu = g.lieu || (m.voie ? '' : g.ville);   // sans rue, le hameau reste la seule adresse
      nb++;
    }
  }
  journaliser('import', `Communes et hameaux : ${nb} maisons mises à jour`);
  $('dlg-lieux').close();
  enregistrer();
  rendreTout();
  toast(`✓ ${nb} maisons mises à jour`);
}

// ============================================================
// RECHERCHE DANS L'HISTORIQUE DES CHANGEMENTS
// ============================================================
const NB_MAX_HISTORIQUE = 50;

function ouvrirHistorique() {
  $('historique-recherche').value = '';
  rendreHistorique();
  $('dlg-historique').showModal();
  $('historique-recherche').focus();
}

function rendreHistorique() {
  const q = normaliser($('historique-recherche').value);
  if (q.length < 2) {
    $('historique-resume').textContent = `${base.historique.length} changement(s) enregistré(s). Tapez au moins 2 lettres : habitant, rue ou lieu-dit.`;
    $('historique-liste').innerHTML = '';
    return;
  }
  const parMaison = new Map();
  for (const h of base.historique) {
    if (!parMaison.has(h.maisonId)) parMaison.set(h.maisonId, []);
    parMaison.get(h.maisonId).push(h);
  }
  const trouvees = [...parMaison.entries()]
    .map(([id, liste]) => ({ m: maison(id), liste: liste.sort((a, b) => String(a.le).localeCompare(String(b.le))) }))
    .filter(x => x.m && [x.m.nom, x.m.numero, x.m.voie, x.m.lieu, x.m.commune].some(v => normaliser(v).includes(q)))
    .sort((a, b) => String(b.liste[b.liste.length - 1].le).localeCompare(String(a.liste[a.liste.length - 1].le)));
  $('historique-resume').textContent = trouvees.length > NB_MAX_HISTORIQUE
    ? `${trouvees.length} maisons trouvées, ${NB_MAX_HISTORIQUE} affichées : précisez la recherche.`
    : `${trouvees.length} maison(s) trouvée(s).`;
  $('historique-liste').innerHTML = trouvees.slice(0, NB_MAX_HISTORIQUE).map(({ m, liste }) => {
    const t = tournee(m.tourneeId);
    return `<article class="historique-maison">
      <b>${esc(adresse(m))}</b> — ${esc(m.nom)} <span class="discret">${esc(t ? t.nom : '')}</span>
      <ul>${liste.map(h => `<li><span class="discret">${dateCourte(h.le)}</span> ${esc(libelleStatut(h))}${h.statut === 'don' ? ' ' + euros(h.don) : ''} <span class="discret">${esc(h.source === 'pc' ? 'PC' : (h.qui || 'Terrain'))}</span></li>`).join('')}</ul>
    </article>`;
  }).join('') || '<p class="discret">Aucun changement pour cette recherche.</p>';
}

// ============================================================
// ANNÉE DE CAMPAGNE
// ============================================================
function changerAnnee(delta) {
  const nouvelle = base.anneeCourante + delta;
  const dejaUtilisee = base.passages.some(p => p.annee === nouvelle);
  if (delta > 0 && !dejaUtilisee && !confirm(`Démarrer la campagne ${nouvelle} ?\n\nToutes les maisons repartent « à passer » ; les dons de ${nouvelle - 1} apparaîtront en historique. Rien n'est effacé : vous pourrez revenir à ${base.anneeCourante} avec ◀.`)) return;
  base.anneeCourante = nouvelle;
  if (delta > 0 && !dejaUtilisee) journaliser('campagne', `Début de la campagne ${nouvelle}`, null, nouvelle);
  enregistrer();
  rendreTout();
}

// ============================================================
// MENU BASE
// ============================================================
function ouvrirMenuBase() {
  $('base-etat').textContent = `${base.tournees.length} tournée(s), ${base.maisons.length} maison(s), ${base.passages.length} passage(s). ` +
    (fichier ? `Fichier : ${fichier.name}.` : 'Aucun fichier lié.') + ` Version ${APP_VERSION}.`;
  const libelles = { envoi: '📤', retour: '📥', import: '📦', campagne: '🗓', geocodage: '🌍', suppression: '🗑', copie: '⬇' };
  $('base-journal').innerHTML = base.journal.slice(-40).reverse().map(j => {
    const t = j.tourneeId ? tournee(j.tourneeId) : null;
    const detail = typeof j.detail === 'object' && j.detail
      ? `retour de ${j.detail.benevole || '?'} : ${j.detail.maj} maj, ${j.detail.nouvelles} nouvelle(s)`
      : j.detail;
    return `<li>${libelles[j.type] || '•'} ${dateCourte(j.le)} — ${t ? esc(t.nom) + ' — ' : ''}${esc(detail)}</li>`;
  }).join('') || '<li>Rien pour l\'instant.</li>';
  $('dlg-base').showModal();
}

// ============================================================
// ÉVÉNEMENTS
// ============================================================
async function action(nom, cible) {
  switch (nom) {
    case 'reprendre-base': {
      fichierAutorise = await verifierPermission(true);
      $('ecran-demarrage').hidden = true;
      $('ecran-app').hidden = false;
      afficherBandeau();
      rendreTout();
      if (fichierAutorise) enregistrerMaintenant();
      break;
    }
    case 'ouvrir-base': case 'changer-base': document.querySelectorAll('dialog[open]').forEach(d => d.close()); await ouvrirBase(); break;
    case 'creer-base': await creerBase(); break;
    case 'importer-v1': document.querySelectorAll('dialog[open]').forEach(d => d.close()); $('fichier-v1').click(); break;
    case 'importer-access': document.querySelectorAll('dialog[open]').forEach(d => d.close()); $('fichier-access').click(); break;
    case 'appliquer-access': appliquerAccess(); break;
    case 'ouvrir-lieux': document.querySelectorAll('dialog[open]').forEach(d => d.close()); ouvrirLieux(); break;
    case 'proposer-communes': proposerCommunes(); break;
    case 'enregistrer-lieux': enregistrerLieux(); break;
    case 'lier-fichier':
      try { await choisirFichierEnregistrement(); toast('💾 Base enregistrée dans ' + fichier.name); }
      catch (e) { if (e.name !== 'AbortError') alert('❌ ' + e.message); }
      break;
    case 'reactiver-fichier':
      fichierAutorise = await verifierPermission(true);
      if (fichierAutorise) await enregistrerMaintenant(); else afficherBandeau();
      break;
    case 'telecharger-copie': telechargerCopie(); break;
    case 'exporter-csv': exporterCsv(); break;
    case 'annee-precedente': changerAnnee(-1); break;
    case 'annee-suivante': changerAnnee(1); break;
    case 'ouvrir-menu-base': ouvrirMenuBase(); break;
    case 'importer-retour': $('fichier-retour').click(); break;
    case 'nouvelle-tournee': ouvrirDialogueTournee(null); break;
    case 'modifier-tournee': ouvrirDialogueTournee(tourneeActiveId); break;
    case 'enregistrer-tournee': enregistrerTournee(); break;
    case 'supprimer-tournee': supprimerTournee(); break;
    case 'nouvelle-maison': ouvrirDialogueMaison(null); break;
    case 'modifier-maison': ouvrirDialogueMaison(cible.closest('tr[data-id]').dataset.id); break;
    case 'ajouter-a-cote': ouvrirDialogueMaison(null, cible.closest('tr[data-id]').dataset.id); break;
    case 'voir-carte': voirSurCarte(cible.closest('tr[data-id]').dataset.id); break;
    case 'placer-carte': demarrerPlacement(cible.closest('tr[data-id]').dataset.id); break;
    case 'placer-fiche': demarrerPlacement(maisonEditee); break;
    case 'placer-hameau': {
      const m = maison(maisonEditee);
      demarrerPlacement(m.id, { ids: maisonsDuHameau(m).map(x => x.id), titre: m.lieu });
      break;
    }
    case 'valider-placement': validerPlacement(); break;
    case 'annuler-placement': terminerPlacement(); rendreCarte(false); break;
    case 'enregistrer-maison': enregistrerMaison(); break;
    case 'supprimer-maison': supprimerMaison(); break;
    case 'geocoder-maison': geocoderMaisonDialogue(); break;
    case 'geocoder-tournee': ouvrirGps(tourneeActiveId); break;
    case 'ouvrir-gps': document.querySelectorAll('dialog[open]').forEach(d => d.close()); ouvrirGps(null); break;
    case 'appliquer-rues': appliquerRues(); break;
    case 'annuler-manuel': annulerManuel(Number(cible.dataset.i)); break;
    case 'ouvrir-historique': document.querySelectorAll('dialog[open]').forEach(d => d.close()); ouvrirHistorique(); break;
    case 'tout-cocher': cocherTout(true); break;
    case 'tout-decocher': cocherTout(false); break;
    case 'placer-selection': placerSelection(); break;
    case 'lancer-gps': lancerGps(); break;
    case 'arreter-gps': gpsArret = true; break;
    case 'exporter-terrain': exporterTerrain(); break;
    case 'appliquer-retour': appliquerRetour(); break;
    case 'imprimer': imprimer(); break;
    case 'fermer-dialogue': cible.closest('dialog').close(); break;
  }
}

function initEvenements() {
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action], [data-ecran], [data-tournee], [data-vue]');
    if (!el) return;
    if (el.dataset.action) { action(el.dataset.action, el); return; }
    if (el.dataset.ecran) { afficherEcran(el.dataset.ecran); return; }
    if (el.dataset.vue) { afficherVueTournee(el.dataset.vue); return; }
    if (el.dataset.tournee) {
      tourneeActiveId = el.dataset.tournee;
      selectionPlacement.clear();
      rechercheMaison = ''; $('recherche-maison').value = '';
      afficherEcran('tournee');
    }
  });

  $('historique-recherche').addEventListener('input', rendreHistorique);
  $('maisons-corps').addEventListener('change', saisieTableau);
  $('maisons-corps').addEventListener('change', (e) => {
    if (!e.target.classList.contains('choix-placement')) return;
    const id = e.target.closest('tr[data-id]').dataset.id;
    if (e.target.checked) selectionPlacement.add(id); else selectionPlacement.delete(id);
    rendreSelection();
  });
  // Entrée dans une cellule = passer à la ligne suivante (saisie rapide d'une feuille papier)
  $('maisons-corps').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.dataset.champ) return;
    e.preventDefault();
    e.target.dispatchEvent(new Event('change', { bubbles: true }));
    let ligne = e.target.closest('tr').nextElementSibling;
    while (ligne && !ligne.dataset.id) ligne = ligne.nextElementSibling;
    if (ligne) ligne.querySelector(`[data-champ="${e.target.dataset.champ}"]`).focus();
  });

  let minuteur = null;
  $('recherche-maison').addEventListener('input', (e) => {
    clearTimeout(minuteur);
    minuteur = setTimeout(() => { rechercheMaison = e.target.value.trim(); rendreMaisons(); }, 150);
  });
  $('filtre-statut').innerHTML = '<option value="">Tous les statuts</option>' +
    OPTIONS_STATUT.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('') +
    '<option value="nouvelle">Nouvelles à valider</option>' +
    '<option value="sans_position">Sans position</option>' +
    '<option value="approchee">Position approchée (≈)</option>';
  $('filtre-statut').addEventListener('change', (e) => { filtreStatut = e.target.value; rendreMaisons(); });

  $('retour-tout').addEventListener('change', (e) => {
    document.querySelectorAll('#retour-corps input[data-ligne]').forEach(c => { c.checked = e.target.checked; });
  });

  $('fichier-retour').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) await lireRetour(f);
  });
  $('fichier-v1').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) await importerV1(f);
  });
  $('fichier-access').addEventListener('change', async (e) => {
    const fichiers = [...e.target.files];
    e.target.value = '';
    if (fichiers.length) await preparerAccess(fichiers);
  });
  $('fichier-base').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try { await chargerBase(JSON.parse(await lireFichierTexte(f)), null); }
    catch (err) { alert('❌ ' + err.message); }
  });

  // Glisser-déposer d'un fichier de retour sur la page
  document.addEventListener('dragover', (e) => { if (base) e.preventDefault(); });
  document.addEventListener('drop', async (e) => {
    if (!base) return;
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) await lireRetour(f);
  });

  window.addEventListener('beforeunload', (e) => {
    if (minuteurEnregistrement && base) { enregistrerMaintenant(); }
  });
}

// ============================================================
// DÉMARRAGE
// ============================================================
async function init() {
  $('version-entete').textContent = 'v' + APP_VERSION;
  initEvenements();
  $('avertissement-navigateur').hidden = FS_DISPONIBLE;
  let copie = null, handle = null;
  try {
    copie = await IDB.lire('base');
    handle = await IDB.lire('fichier');
  } catch (e) { console.warn('IndexedDB indisponible', e); }

  if (copie) {
    base = validerBase(JSON.parse(copie));
    indexer();
    fichier = handle || null;
    tourneeActiveId = base.tournees[0] ? base.tournees[0].id : null;
    fichierAutorise = await verifierPermission(false);
    if (fichier && !fichierAutorise) {
      // Le navigateur exige un clic pour réautoriser l'accès au fichier
      $('btn-reprendre').hidden = false;
      $('nom-base-precedente').textContent = fichier.name;
      $('ecran-demarrage').hidden = false;
      return;
    }
    $('ecran-app').hidden = false;
    afficherBandeau();
    rendreTout();
  } else {
    $('ecran-demarrage').hidden = false;
  }
}

init();
