/* =============================================
   GESTION DES TOURNÉES — PC (V2)
   Modèle et formats : voir SPEC.md §8.3 et §8.4ter
   ============================================= */

'use strict';

const APP_VERSION = '0.1.0';
const FORMAT_BASE = 'base-tournees-bozouls';
const FORMAT_TOURNEE = 'tournee-bozouls';
const FORMAT_RETOUR = 'retour-tournee-bozouls';
const SCHEMA_VERSION = 1;
const NB_ANNEES_HISTORIQUE = 3;   // années précédentes envoyées au terrain

const STATUTS = {
  a_visiter:     'À visiter',
  don:           'Don',
  absent:        'Absent',
  repasser:      'À repasser',
  boite_lettres: 'Boîte aux lettres',
  refuse:        'Refus',
  autre:         'Autre'
};
const ETATS = {
  habitee:    'Habitée',
  inhabitee:  'Inhabitée / vide',
  secondaire: 'Résidence secondaire',
  disparue:   'N\'existe plus'
};
const COULEURS = {
  a_visiter: '#8a94a3', don: '#1e8e3e', absent: '#d48a00', repasser: '#7b3fe4',
  boite_lettres: '#0b7fa8', refuse: '#c62828', autre: '#4a5566'
};

// ============================================================
// ÉTAT
// ============================================================
let base = null;              // contenu de base_tournees.json
let indexPassages = new Map(); // "maisonId|annee" -> passage
let fichier = null;           // FileSystemFileHandle de la base (null = navigateur seulement)
let fichierAutorise = false;  // permission d'écriture accordée dans cette session
let tourneeActiveId = null;
let ecranActif = 'tableau';
let vueTournee = 'tableau';
let rechercheMaison = '';
let filtreStatut = '';
let maisonEditee = null;      // id (null = nouvelle)
let gpsDialogue = null;       // { lat, lng, score, label } trouvé dans la fiche maison
let retourEnCours = null;     // { retour, lignes }
let carte = null, coucheCarte = null;

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
    journal: []
  };
}

function validerBase(donnees) {
  if (!donnees || donnees.format !== FORMAT_BASE) throw new Error('Ce fichier n\'est pas une base de tournées.');
  if (donnees.schemaVersion > SCHEMA_VERSION) throw new Error('Cette base vient d\'une version plus récente de l\'application.');
  ['tournees', 'maisons', 'passages', 'journal'].forEach(k => { if (!Array.isArray(donnees[k])) donnees[k] = []; });
  return donnees;
}

function cle(maisonId, annee) { return maisonId + '|' + annee; }

function indexer() {
  indexPassages = new Map(base.passages.map(p => [cle(p.maisonId, p.annee), p]));
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
  if (p.statut !== 'don') p.don = 0;
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

function trierMaisons(liste) {
  return [...liste].sort((a, b) =>
    normaliser(a.commune).localeCompare(normaliser(b.commune)) ||
    (a.ordreLieu || 0) - (b.ordreLieu || 0) ||
    normaliser(a.lieu).localeCompare(normaliser(b.lieu)) ||
    (a.ordreRue || 0) - (b.ordreRue || 0) ||
    normaliser(a.voie).localeCompare(normaliser(b.voie)) ||
    String(a.numero || '').localeCompare(String(b.numero || ''), 'fr', { numeric: true })
  );
}

function statsTournee(tourneeId, annee) {
  const maisons = maisonsDe(tourneeId).filter(estConcernee);
  let faites = 0, dons = 0, total = 0, totalN1 = 0;
  for (const m of maisons) {
    const p = passage(m.id, annee);
    if (p.statut !== 'a_visiter') faites++;
    if (p.statut === 'don') { dons++; total += p.don || 0; }
    const p1 = passage(m.id, annee - 1);
    if (p1.statut === 'don') totalN1 += p1.don || 0;
  }
  return { maisons: maisons.length, faites, dons, total, totalN1 };
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
  let maisons = 0, faites = 0, dons = 0, total = 0, totalN1 = 0;
  const lignes = [...base.tournees].sort((x, y) => normaliser(x.nom).localeCompare(normaliser(y.nom))).map(t => {
    const s = statsTournee(t.id, a);
    maisons += s.maisons; faites += s.faites; dons += s.dons; total += s.total; totalN1 += s.totalN1;
    const pct = s.maisons ? Math.round(s.faites / s.maisons * 100) : 0;
    return `<tr class="lien" data-tournee="${esc(t.id)}">
      <td><b>${esc(t.nom)}</b></td><td>${esc(t.responsable || '')}</td>
      <td class="num">${s.maisons}</td>
      <td><div class="mini-barre" style="width:120px;display:inline-block;vertical-align:middle"><div style="width:${pct}%"></div></div> ${pct} %</td>
      <td class="num">${s.dons}</td><td class="num">${euros(s.total)}</td><td class="num">${euros(s.totalN1)}</td>
      <td class="num">${evolution(s.total, s.totalN1)}</td>
      <td>${dateCourte(dernierRetour(t.id, a))}</td>
    </tr>`;
  });
  $('tableau-corps').innerHTML = lignes.join('') || '<tr><td colspan="9" class="vide">Aucune tournée. Créez-en une avec ＋ ou importez une sauvegarde (⚙).</td></tr>';
  $('tableau-chiffres').innerHTML =
    carteChiffre(base.tournees.length, 'tournées') +
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
    carteChiffre(s.dons, 'dons') +
    carteChiffre(euros(s.total), `total ${a}`) +
    carteChiffre(euros(s.totalN1), `total ${a - 1}`) +
    carteChiffre(repasser, 'absents / à repasser') +
    (aValider ? carteChiffre(aValider, 'nouvelles à valider', 'evol-moins') : '') +
    (sansGps ? carteChiffre(sansGps, 'sans position GPS') : '');
}

function texteHistorique(p) {
  if (p.statut === 'a_visiter') return '';
  return p.statut === 'don' ? euros(p.don) : STATUTS[p.statut] || p.statut;
}

function correspondFiltres(m, a) {
  if (filtreStatut) {
    if (filtreStatut === 'nouvelle') { if (!m.nouvelle) return false; }
    else if (passage(m.id, a).statut !== filtreStatut) return false;
  }
  if (!rechercheMaison) return true;
  const q = normaliser(rechercheMaison);
  return [m.numero, m.voie, m.lieu, m.commune, m.nom, m.infos, passage(m.id, a).remarque].some(v => normaliser(v).includes(q));
}

function rendreMaisons() {
  const a = base.anneeCourante;
  const maisons = trierMaisons(maisonsDe(tourneeActiveId)).filter(m => correspondFiltres(m, a));
  const optionsStatut = Object.entries(STATUTS);
  let html = '', dernierGroupe = null, n = 0;
  for (const m of maisons) {
    const groupe = [m.commune, m.lieu].filter(Boolean).join(' — ') || 'Sans lieu-dit';
    if (groupe !== dernierGroupe) {
      html += `<tr class="groupe"><td colspan="11">📍 ${esc(groupe)}${m.ordreLieu ? ` <span class="discret">(ordre ${m.ordreLieu})</span>` : ''}</td></tr>`;
      dernierGroupe = groupe;
    }
    n++;
    const p = passage(m.id, a);
    const etiquettes = (m.etat !== 'habitee' ? ` <span class="etiquette">${esc(ETATS[m.etat] || m.etat)}</span>` : '') +
                       (m.nouvelle ? ' <span class="etiquette etiquette-nouvelle">Nouvelle — à valider</span>' : '');
    html += `<tr data-id="${esc(m.id)}" class="${estConcernee(m) ? '' : 'inactive'}">
      <td class="num">${n}</td>
      <td>${esc(m.numero)}</td>
      <td>${esc(m.voie)}${m.lat == null ? ' <span title="Pas de position GPS">📍?</span>' : ''}</td>
      <td>${esc(m.nom)}${m.infos ? `<div class="discret" style="font-size:12px">ℹ️ ${esc(m.infos)}</div>` : ''}</td>
      <td>${etiquettes.trim() || '<span class="discret">Habitée</span>'}</td>
      <td class="num discret">${esc(texteHistorique(passage(m.id, a - 2)))}</td>
      <td class="num discret">${esc(texteHistorique(passage(m.id, a - 1)))}</td>
      <td><select class="statut-select" data-champ="statut" data-statut="${esc(p.statut)}">
        ${optionsStatut.map(([k, l]) => `<option value="${k}"${k === p.statut ? ' selected' : ''}>${esc(l)}</option>`).join('')}
      </select></td>
      <td><input class="saisie-don" data-champ="don" inputmode="decimal" value="${p.statut === 'don' && p.don ? esc(String(p.don).replace('.', ',')) : ''}" /></td>
      <td><input data-champ="remarque" value="${esc(p.remarque || '')}" title="${esc(p.benevole ? 'Saisi par ' + p.benevole : '')}" /></td>
      <td><button class="btn-icone" data-action="modifier-maison" title="Fiche maison">✏️</button></td>
    </tr>`;
  }
  $('maisons-corps').innerHTML = html ||
    `<tr><td colspan="11" class="vide">${rechercheMaison || filtreStatut ? 'Aucune maison pour ce filtre.' : 'Aucune maison. Ajoutez-en avec « ➕ Maison ».'}</td></tr>`;
}

// Saisie directe dans le tableau (retours papier, dons remis en main propre…)
function saisieTableau(e) {
  const champ = e.target.dataset.champ;
  const ligne = e.target.closest('tr[data-id]');
  if (!champ || !ligne) return;
  const id = ligne.dataset.id;
  const a = base.anneeCourante;
  const actuel = passage(id, a);
  const valeurs = { modifieLe: maintenant(), source: 'pc', benevole: '' };

  if (champ === 'statut') {
    valeurs.statut = e.target.value;
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

  // Mise à jour locale de la ligne sans tout redessiner (garde le focus pour la saisie au clavier)
  const select = ligne.querySelector('[data-champ="statut"]');
  select.value = p.statut;
  select.dataset.statut = p.statut;
  const don = ligne.querySelector('[data-champ="don"]');
  if (document.activeElement !== don || champ === 'statut') don.value = p.statut === 'don' && p.don ? String(p.don).replace('.', ',') : '';

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

function ouvrirDialogueMaison(id) {
  maisonEditee = id;
  const m = id ? maison(id) : null;
  gpsDialogue = null;
  remplirListes();
  $('m-etat').innerHTML = Object.entries(ETATS).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('');
  $('m-tournee').innerHTML = base.tournees.map(t => `<option value="${esc(t.id)}">${esc(t.nom)}</option>`).join('');

  // Nouvelle maison : on reprend commune / lieu / voie de la dernière maison de la tournée
  const modele = m || trierMaisons(maisonsDe(tourneeActiveId)).pop() || {};
  $('dlg-maison-titre').textContent = m ? adresse(m) : 'Nouvelle maison';
  $('m-commune').value = modele.commune || '';
  $('m-lieu').value = modele.lieu || '';
  $('m-ordre-lieu').value = modele.ordreLieu || '';
  $('m-numero').value = m ? m.numero || '' : '';
  $('m-voie').value = modele.voie || '';
  $('m-ordre-rue').value = modele.ordreRue || '';
  $('m-nom').value = m ? m.nom || '' : '';
  $('m-etat').value = m ? m.etat || 'habitee' : 'habitee';
  $('m-tournee').value = m ? m.tourneeId : tourneeActiveId;
  $('m-infos').value = m ? m.infos || '' : '';
  $('m-gps').textContent = m && m.lat != null ? `Position : ${m.lat.toFixed(5)}, ${m.lng.toFixed(5)}` : 'Position : —';
  $('m-gps-resultat').textContent = m && m.geoLabel ? `BAN : ${m.geoLabel}` : '';

  const passages = m ? base.passages.filter(p => p.maisonId === m.id && p.statut !== 'a_visiter').sort((x, y) => y.annee - x.annee) : [];
  $('m-historique').innerHTML = passages.map(p =>
    `<span><b>${p.annee}</b> : ${esc(texteHistorique(p))}${p.remarque ? ' — ' + esc(p.remarque) : ''}${p.benevole ? ` <i class="discret">(${esc(p.benevole)})</i>` : ''}</span>`
  ).join('') || '<span class="discret">Aucun passage enregistré.</span>';

  $('btn-supprimer-maison').hidden = !m;
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
    infos: $('m-infos').value.trim()
  };
  if (!valeurs.voie && !valeurs.lieu) { alert('Indiquez au moins une voie ou un lieu-dit.'); return; }
  if (gpsDialogue) Object.assign(valeurs, { lat: gpsDialogue.lat, lng: gpsDialogue.lng, geoScore: gpsDialogue.score, geoLabel: gpsDialogue.label });

  if (maisonEditee) {
    const m = maison(maisonEditee);
    Object.assign(m, valeurs);
    m.nouvelle = false;   // une maison relue et enregistrée sur le PC est validée
  } else {
    base.maisons.push({ id: uid('m-'), lat: null, lng: null, nouvelle: false, refExterne: '', creeLe: maintenant(), ...valeurs });
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

async function geocoderTournee() {
  const aTraiter = maisonsDe(tourneeActiveId).filter(m => m.lat == null && m.etat !== 'disparue');
  if (aTraiter.length === 0) { toast('Toutes les maisons ont déjà une position.'); return; }
  if (!confirm(`Chercher la position de ${aTraiter.length} maison(s) dans la Base Adresse Nationale ?\n\nSeule l'adresse (sans nom) est envoyée. Les adresses saisies ne sont pas modifiées.`)) return;
  let ok = 0, douteux = 0, echec = 0;
  for (const [i, m] of aTraiter.entries()) {
    toast(`🌍 ${i + 1} / ${aTraiter.length}…`);
    try {
      const r = await geocoder(m);
      if (r && r.score >= 0.4) {
        Object.assign(m, { lat: r.lat, lng: r.lng, geoScore: r.score, geoLabel: r.label });
        ok++;
        if (r.score < 0.6) douteux++;
      } else echec++;
    } catch (e) { echec++; }
    await new Promise(res => setTimeout(res, 60));   // limite du service : 50 requêtes / seconde
  }
  journaliser('geocodage', `${ok} trouvées, ${echec} non trouvées`, tourneeActiveId);
  enregistrer();
  rendreTournee();
  alert(`Géocodage terminé :\n✓ ${ok} position(s) trouvée(s)${douteux ? ` (dont ${douteux} à vérifier sur la carte)` : ''}\n✗ ${echec} non trouvée(s) : à placer avec l'app terrain (« Je suis devant »).`);
}

// ============================================================
// CARTE
// ============================================================
function afficherVueTournee(vue) {
  vueTournee = vue;
  document.querySelectorAll('.vue').forEach(b => b.classList.toggle('actif', b.dataset.vue === vue));
  $('vue-tableau').hidden = vue !== 'tableau';
  $('vue-carte').hidden = vue !== 'carte';
  if (vue === 'carte') rendreCarte(true); else rendreMaisons();
}

function rendreCarte(cadrer) {
  if (typeof L === 'undefined') { $('carte').textContent = 'Carte indisponible (pas de connexion).'; return; }
  if (!carte) {
    carte = L.map('carte').setView([44.47, 2.72], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(carte);
    coucheCarte = L.layerGroup().addTo(carte);
  }
  setTimeout(() => carte.invalidateSize(), 30);
  coucheCarte.clearLayers();
  const a = base.anneeCourante;
  const points = [];
  for (const m of maisonsDe(tourneeActiveId)) {
    if (m.lat == null) continue;
    const p = passage(m.id, a);
    const mk = L.circleMarker([m.lat, m.lng], { radius: 8, weight: 2, color: '#fff', fillOpacity: .95, fillColor: COULEURS[p.statut] || COULEURS.autre });
    mk.bindTooltip(`${esc(adresse(m))} — ${esc(m.nom)}<br>${esc(STATUTS[p.statut])}${p.statut === 'don' ? ' ' + euros(p.don) : ''}`);
    mk.on('click', () => ouvrirDialogueMaison(m.id));
    mk.addTo(coucheCarte);
    points.push([m.lat, m.lng]);
  }
  if (cadrer && points.length) carte.fitBounds(points, { padding: [30, 30], maxZoom: 17 });
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
function decrire(p, etat, nom) {
  const morceaux = [STATUTS[p.statut] || p.statut];
  if (p.statut === 'don') morceaux[0] += ' ' + euros(p.don);
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
    if (!changeNom && !changeEtat && !changeGps && !changePassage) { aJour++; continue; }
    const pcPlusRecent = avant.modifieLe && apres.modifieLe && avant.modifieLe > apres.modifieLe;
    lignes.push({ type: 'maison', r, m, avant, apres, changeNom, changeEtat, changeGps, changePassage, pcPlusRecent, coche: !pcPlusRecent });
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
      <td class="discret">${esc(decrire(l.avant, l.changeEtat ? l.m.etat : null, l.changeNom ? l.m.nom || '—' : null))}${l.pcPlusRecent ? '<br>⚠️ modifié sur le PC le ' + dateCourte(l.avant.modifieLe) : ''}</td>
      <td>${esc(decrire(l.apres, l.changeEtat ? l.r.etat : null, l.changeNom ? l.r.nom || '—' : null))}${l.changeGps ? ' · 📍 position' : ''}</td></tr>`;
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
      if (l.changeGps) { l.m.lat = l.r.lat; l.m.lng = l.r.lng; l.m.geoLabel = 'Relevé sur le terrain'; }
      nbMaj++;
    } else if (l.type === 'nouvelle') {
      const n = l.r;
      base.maisons.push({
        id: n.id, tourneeId: retour.tourneeId, commune: n.commune || '', lieu: n.lieu || '',
        ordreLieu: Number(n.ordreLieu) || 0, numero: n.numero || '', voie: n.voie || '', ordreRue: Number(n.ordreRue) || 0,
        nom: n.nom || '', etat: n.etat || 'habitee', lat: n.lat ?? null, lng: n.lng ?? null, infos: n.infos || '',
        nouvelle: true, refExterne: '', creeLe: maintenant()
      });
      if (n.passage) {
        const p = ecrirePassage(n.id, annee, { ...n.passage, source: 'terrain', benevole: retour.benevole || '' });
        p.modifieLe = n.passage.modifieLe || maintenant();
      }
      nbNouvelles++;
    }
  });
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
  const enTete = ['Tournée', 'Commune', 'Lieu-dit', 'N°', 'Voie', 'Habitant', 'État', `Statut ${a}`, `Don ${a}`, `Remarque ${a}`, `Don ${a - 1}`, 'Saisi par', 'Latitude', 'Longitude'];
  const lignes = [enTete];
  for (const t of base.tournees) {
    for (const m of trierMaisons(maisonsDe(t.id))) {
      const p = passage(m.id, a), p1 = passage(m.id, a - 1);
      lignes.push([t.nom, m.commune, m.lieu, m.numero, m.voie, m.nom, ETATS[m.etat] || m.etat, STATUTS[p.statut],
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
// ANNÉE DE CAMPAGNE
// ============================================================
function changerAnnee(delta) {
  const nouvelle = base.anneeCourante + delta;
  const dejaUtilisee = base.passages.some(p => p.annee === nouvelle);
  if (delta > 0 && !dejaUtilisee && !confirm(`Démarrer la campagne ${nouvelle} ?\n\nToutes les maisons repartent « à visiter » ; les dons de ${nouvelle - 1} apparaîtront en historique. Rien n'est effacé : vous pourrez revenir à ${base.anneeCourante} avec ◀.`)) return;
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
    case 'enregistrer-maison': enregistrerMaison(); break;
    case 'supprimer-maison': supprimerMaison(); break;
    case 'geocoder-maison': geocoderMaisonDialogue(); break;
    case 'geocoder-tournee': geocoderTournee(); break;
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
      rechercheMaison = ''; $('recherche-maison').value = '';
      afficherEcran('tournee');
    }
  });

  $('maisons-corps').addEventListener('change', saisieTableau);
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
    Object.entries(STATUTS).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('') +
    '<option value="nouvelle">Nouvelles à valider</option>';
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
