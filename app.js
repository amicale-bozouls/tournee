/* =============================================
   TOURNÉE CALENDRIERS — APP TERRAIN (prototype V2)
   Format d'échange : voir SPEC.md §8.3
   ============================================= */

'use strict';

const APP_VERSION = '0.1.6';
const CLE_STOCKAGE = 'tournee_terrain_v2';
const CLE_BENEVOLE = 'tournee_terrain_benevole';
const FORMAT_TOURNEE = 'tournee-bozouls';
const FORMAT_RETOUR = 'retour-tournee-bozouls';

const STATUTS = {
  a_visiter:     { libelle: 'À visiter',  court: '—' },
  don:           { libelle: 'Don',        court: 'Don' },
  absent:        { libelle: 'Absent',     court: 'Absent' },
  repasser:      { libelle: 'À repasser', court: 'Repasser' },
  boite_lettres: { libelle: 'Boîte aux lettres', court: 'BAL' },
  refuse:        { libelle: 'Refus',      court: 'Refus' },
  autre:         { libelle: 'Autre',      court: 'Autre' }
};
const ACTIONS_RAPIDES = ['don', 'absent', 'repasser', 'boite_lettres', 'refuse'];
const ETATS = {
  habitee:   'Habitée',
  inhabitee: 'Inhabitée / vide',
  secondaire: 'Résidence secondaire',
  disparue:  'N\'existe plus'
};
const COULEURS = {
  a_visiter: '#8a94a3', don: '#1e8e3e', absent: '#d48a00', repasser: '#7b3fe4',
  boite_lettres: '#0b7fa8', refuse: '#c62828', autre: '#4a5566'
};

// ============================================================
// ÉTAT
// ============================================================
// { tournee, maisons, benevole, dernierEnvoi, importeLe }
let etat = null;
let filtre = 'toutes';
let recherche = '';
let maisonEnCours = null;   // id de la maison ouverte dans une feuille (null = nouvelle)
let gpsEnCours = null;      // { lat, lng, precision } capturé dans la fiche
let carte = null;
let coucheMarqueurs = null;
let marqueurMoi = null;

function chargerEtat() {
  try {
    const brut = localStorage.getItem(CLE_STOCKAGE);
    etat = brut ? JSON.parse(brut) : null;
  } catch (e) {
    console.warn('Stockage illisible', e);
    etat = null;
  }
}

function sauverEtat() {
  try {
    localStorage.setItem(CLE_STOCKAGE, JSON.stringify(etat));
  } catch (e) {
    alerte('⚠️ Impossible d\'enregistrer sur ce téléphone (mémoire pleine ?). Envoyez votre retour rapidement.');
  }
}

// ============================================================
// OUTILS
// ============================================================
const $ = (id) => document.getElementById(id);

function esc(valeur) {
  return String(valeur ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function uid() {
  return 'n-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function maintenant() {
  return new Date().toISOString();
}

function lireMontant(texte) {
  const n = parseFloat(String(texte || '').replace(',', '.').replace(/[^\d.]/g, ''));
  return isNaN(n) ? 0 : Math.round(n * 100) / 100;
}

function euros(n) {
  return (Number(n) || 0).toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' €';
}

function heure(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) + ' à ' +
         d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function normaliser(texte) {
  return String(texte || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

let minuteurToast = null;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('visible');
  clearTimeout(minuteurToast);
  minuteurToast = setTimeout(() => el.classList.remove('visible'), 2200);
}

function alerte(message) {
  window.alert(message);
}

function adresseMaison(m) {
  return [m.numero, m.voie].filter(Boolean).join(' ') || m.lieu || 'Sans adresse';
}

function dernierHistorique(m) {
  const h = (m.historique || []).slice().sort((a, b) => (b.annee || 0) - (a.annee || 0));
  return h[0] || null;
}

function maisonsTriees() {
  return [...etat.maisons].sort((a, b) =>
    normaliser(a.commune).localeCompare(normaliser(b.commune)) ||
    (a.ordreLieu || 0) - (b.ordreLieu || 0) ||
    normaliser(a.lieu).localeCompare(normaliser(b.lieu)) ||
    (a.ordreRue || 0) - (b.ordreRue || 0) ||
    normaliser(a.voie).localeCompare(normaliser(b.voie)) ||
    String(a.numero || '').localeCompare(String(b.numero || ''), 'fr', { numeric: true })
  );
}

// Une maison inhabitée / disparue n'a pas besoin d'être visitée
function estAVisiter(m) {
  return m.passage.statut === 'a_visiter' && m.etat !== 'inhabitee' && m.etat !== 'disparue';
}

function nbNonEnvoyes() {
  return etat.maisons.filter(m => m.passage.modifieLe && (!etat.dernierEnvoi || m.passage.modifieLe > etat.dernierEnvoi)).length;
}

// ============================================================
// IMPORT D'UN FICHIER DE TOURNÉE
// ============================================================
function validerFichierTournee(donnees) {
  if (!donnees || donnees.format !== FORMAT_TOURNEE) {
    throw new Error('Ce fichier n\'est pas un fichier de tournée.');
  }
  if (donnees.version > 1) {
    throw new Error('Ce fichier vient d\'une version plus récente. Mettez l\'application à jour (rechargez la page avec du réseau).');
  }
  if (!donnees.tournee || !donnees.tournee.id || !Array.isArray(donnees.maisons)) {
    throw new Error('Fichier de tournée incomplet.');
  }
}

function preparerMaison(m) {
  return {
    id: String(m.id),
    commune: m.commune || '',
    lieu: m.lieu || '',
    ordreLieu: Number(m.ordreLieu) || 0,
    numero: m.numero != null ? String(m.numero) : '',
    voie: m.voie || '',
    ordreRue: Number(m.ordreRue) || 0,
    nom: m.nom || '',
    etat: ETATS[m.etat] ? m.etat : 'habitee',
    lat: typeof m.lat === 'number' ? m.lat : null,
    lng: typeof m.lng === 'number' ? m.lng : null,
    infos: m.infos || '',
    historique: Array.isArray(m.historique) ? m.historique : [],
    nouvelle: !!m.nouvelle,
    passage: {
      statut: (m.passage && STATUTS[m.passage.statut]) ? m.passage.statut : 'a_visiter',
      don: lireMontant(m.passage && m.passage.don),
      remarque: (m.passage && m.passage.remarque) || '',
      modifieLe: (m.passage && m.passage.modifieLe) || null
    }
  };
}

function importerTournee(donnees) {
  validerFichierTournee(donnees);
  const maisons = donnees.maisons.map(preparerMaison);

  if (etat && etat.tournee) {
    if (etat.tournee.id === donnees.tournee.id) {
      // Même tournée renvoyée par le PC : on garde les saisies locales plus récentes
      const locales = new Map(etat.maisons.map(m => [m.id, m]));
      for (const m of maisons) {
        const l = locales.get(m.id);
        if (l && l.passage.modifieLe && (!m.passage.modifieLe || l.passage.modifieLe > m.passage.modifieLe)) {
          m.passage = l.passage;
          m.etat = l.etat;
          m.nom = l.nom;
          if (l.lat != null) { m.lat = l.lat; m.lng = l.lng; }
        }
        locales.delete(m.id);
      }
      // Les maisons créées ici et pas encore connues du PC sont conservées
      for (const l of locales.values()) if (l.nouvelle) maisons.push(l);
    } else {
      const reste = nbNonEnvoyes();
      const msg = reste > 0
        ? `⚠️ ${reste} saisie(s) de « ${etat.tournee.nom} » n'ont pas été envoyées.\n\nRemplacer quand même par « ${donnees.tournee.nom} » ?`
        : `Remplacer « ${etat.tournee.nom} » par « ${donnees.tournee.nom} » ?`;
      if (!confirm(msg)) return false;
    }
  }

  etat = {
    tournee: donnees.tournee,
    maisons,
    benevole: (etat && etat.benevole) || localStorage.getItem(CLE_BENEVOLE) || '',
    dernierEnvoi: (etat && etat.tournee && etat.tournee.id === donnees.tournee.id) ? etat.dernierEnvoi : null,
    importeLe: maintenant()
  };
  sauverEtat();
  return true;
}

function ouvrirTexteTournee(texte, diagnostic = '') {
  try {
    // Certains envois ajoutent une marque d'encodage (BOM) ou des espaces autour du contenu
    const propre = String(texte || '').replace(/^\uFEFF/, '').trim();
    if (!propre) throw new Error('Le fichier reçu est vide.' + (diagnostic ? `\n\nReçu : ${diagnostic}` : '') +
      '\n\nEn attendant, utilisez « Ouvrir un fichier de tournée ».');
    let donnees;
    try {
      donnees = JSON.parse(propre);
    } catch (e) {
      throw new Error('Fichier illisible (ce n\'est pas un fichier de tournée).' +
        (diagnostic ? `\n\nReçu : ${diagnostic}\nDébut : ${propre.slice(0, 60)}` : ''));
    }
    if (donnees && donnees.format === FORMAT_RETOUR) {
      throw new Error('Ce fichier est un retour de tournée : il s\'ouvre sur le PC du responsable, pas ici.');
    }
    if (importerTournee(donnees)) {
      afficher();
      toast(`✅ Tournée « ${etat.tournee.nom} » chargée`);
    }
  } catch (e) {
    alerte('❌ ' + e.message);
  }
}

function lireFichierChoisi(fichier) {
  const lecteur = new FileReader();
  lecteur.onload = () => ouvrirTexteTournee(lecteur.result);
  lecteur.onerror = () => alerte('❌ Impossible de lire le fichier.');
  lecteur.readAsText(fichier, 'utf-8');
}

// Fichier reçu par « Partager → Tournée » (déposé par le service worker, voir sw.js)
async function ouvrirFichierPartage() {
  if (!new URLSearchParams(location.search).has('partage')) return;
  history.replaceState(null, '', location.pathname);
  try {
    const cache = await caches.open('partage');
    const rep = await cache.match('fichier-partage');
    if (!rep) { alerte('❌ Le fichier partagé n\'a pas pu être récupéré. Réessayez, ou utilisez « Ouvrir un fichier de tournée ».'); return; }
    await cache.delete('fichier-partage');
    ouvrirTexteTournee(await rep.text(), decodeURIComponent(rep.headers.get('X-Recu') || ''));
  } catch (e) {
    alerte('❌ Fichier partagé illisible : ' + e.message);
  }
}

async function chargerDemo() {
  try {
    const rep = await fetch('demo/tournee_demo.json', { cache: 'no-cache' });
    const donnees = await rep.json();
    if (importerTournee(donnees)) {
      afficher();
      toast('Tournée de démonstration chargée');
    }
  } catch (e) {
    alerte('❌ Démo indisponible : ' + e.message);
  }
}

// ============================================================
// RETOUR VERS LE PC
// ============================================================
function construireRetour() {
  const modifiees = etat.maisons.filter(m => m.passage.modifieLe || m.nouvelle);
  return {
    format: FORMAT_RETOUR,
    version: 1,
    envoyeLe: maintenant(),
    appVersion: APP_VERSION,
    tourneeId: etat.tournee.id,
    annee: etat.tournee.annee,
    benevole: etat.benevole || '',
    maisons: modifiees.filter(m => !m.nouvelle).map(m => ({
      id: m.id, passage: m.passage, etat: m.etat, nom: m.nom, lat: m.lat, lng: m.lng
    })),
    nouvelles: modifiees.filter(m => m.nouvelle).map(m => ({ ...m, aValider: true }))
  };
}

async function envoyerRetour() {
  if (!etat) return;
  if (!etat.benevole) {
    const prenom = prompt('Votre prénom (pour que le responsable sache de qui vient le retour) :', '');
    if (prenom === null) return;
    enregistrerBenevole(prenom);
  }

  const retour = construireRetour();
  const nbModifs = retour.maisons.length + retour.nouvelles.length;
  if (nbModifs === 0 && !confirm('Aucune saisie pour l\'instant. Envoyer quand même ?')) return;

  const horodatage = retour.envoyeLe.slice(0, 16).replace(/[-:T]/g, '');
  const nomFichier = `retour_${(etat.tournee.nom || 'tournee').replace(/[^a-z0-9]+/gi, '_')}_${etat.tournee.annee || ''}_${horodatage}.json`;
  const contenu = JSON.stringify(retour);
  const fichier = new File([contenu], nomFichier, { type: 'application/json' });

  let envoye = false;
  if (navigator.canShare && navigator.canShare({ files: [fichier] })) {
    try {
      await navigator.share({
        files: [fichier],
        title: 'Retour de tournée',
        text: `Retour « ${etat.tournee.nom} » — ${nbModifs} maison(s) — ${etat.benevole || ''}`
      });
      envoye = true;
    } catch (e) {
      if (e.name === 'AbortError') return;
      console.warn('Partage impossible, téléchargement', e);
    }
  }
  if (!envoye) {
    const lien = document.createElement('a');
    lien.href = URL.createObjectURL(fichier);
    lien.download = nomFichier;
    document.body.appendChild(lien);
    lien.click();
    lien.remove();
    setTimeout(() => URL.revokeObjectURL(lien.href), 1000);
    alerte('📥 Fichier de retour enregistré dans vos téléchargements.\nEnvoyez-le au responsable par WhatsApp ou mail.');
  }

  etat.dernierEnvoi = retour.envoyeLe;
  sauverEtat();
  afficherCompteurs();
  toast('📤 Retour envoyé');
}

function enregistrerBenevole(prenom) {
  etat.benevole = String(prenom || '').trim();
  try { localStorage.setItem(CLE_BENEVOLE, etat.benevole); } catch (e) { /* non bloquant */ }
  sauverEtat();
}

function effacerTournee() {
  const reste = nbNonEnvoyes();
  const msg = reste > 0
    ? `⚠️ ${reste} saisie(s) n'ont pas été envoyées et seront perdues.\n\nEffacer la tournée de ce téléphone ?`
    : 'Effacer la tournée de ce téléphone ?\n(Faites-le une fois votre retour bien reçu par le responsable.)';
  if (!confirm(msg)) return;
  // Le prénom (CLE_BENEVOLE) est conservé pour la prochaine tournée
  etat = null;
  localStorage.removeItem(CLE_STOCKAGE);
  fermerFeuilles();
  afficher();
}

// ============================================================
// SAISIES
// ============================================================
function trouverMaison(id) {
  return etat.maisons.find(m => m.id === id);
}

function changerStatut(id, statut) {
  const m = trouverMaison(id);
  if (!m) return;
  if (statut === 'don') { ouvrirFeuilleDon(id); return; }
  // Un 2e appui sur le statut actif l'annule
  const nouveau = m.passage.statut === statut ? 'a_visiter' : statut;
  m.passage.statut = nouveau;
  m.passage.don = 0;
  m.passage.modifieLe = maintenant();
  sauverEtat();
  afficherListe();
  afficherCompteurs();
  if (carte) afficherMarqueurs(false);
  toast(nouveau === 'a_visiter' ? '↩️ Annulé' : `✓ ${STATUTS[nouveau].libelle}`);
}

function ouvrirFeuilleDon(id) {
  const m = trouverMaison(id);
  maisonEnCours = id;
  $('don-titre').textContent = `Don — ${adresseMaison(m)}`;
  const h = dernierHistorique(m);
  $('don-rappel').textContent = [m.nom, h && h.don > 0 ? `${h.annee} : ${euros(h.don)}` : ''].filter(Boolean).join(' · ');
  $('don-montant').value = m.passage.don > 0 ? String(m.passage.don).replace('.', ',') : '';

  const montants = new Set([5, 10, 15, 20]);
  if (h && h.don > 0) montants.add(h.don);
  $('don-raccourcis').innerHTML = [...montants].sort((a, b) => a - b).slice(0, 8)
    .map(v => `<button type="button" data-montant="${v}">${esc(euros(v))}</button>`).join('');

  ouvrirFeuille('feuille-don');
  setTimeout(() => $('don-montant').focus(), 150);
}

function validerDon() {
  const m = trouverMaison(maisonEnCours);
  if (!m) return;
  const montant = lireMontant($('don-montant').value);
  if (montant <= 0 && !confirm('Montant à 0 €. Enregistrer quand même comme « Don » ?')) return;
  m.passage.statut = 'don';
  m.passage.don = montant;
  m.passage.modifieLe = maintenant();
  sauverEtat();
  fermerFeuilles();
  afficherListe();
  afficherCompteurs();
  if (carte) afficherMarqueurs(false);
  toast(`💶 Don de ${euros(montant)} enregistré`);
}

function remplirSelects() {
  $('m-statut').innerHTML = Object.entries(STATUTS).map(([k, s]) => `<option value="${k}">${esc(s.libelle)}</option>`).join('');
  $('m-etat').innerHTML = Object.entries(ETATS).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('');
}

function remplirListesSaisie() {
  const voies = new Set(), lieux = new Set();
  etat.maisons.forEach(m => { if (m.voie) voies.add(m.voie); if (m.lieu) lieux.add(m.lieu); });
  $('liste-voies').innerHTML = [...voies].sort().map(v => `<option value="${esc(v)}">`).join('');
  $('liste-lieux').innerHTML = [...lieux].sort().map(v => `<option value="${esc(v)}">`).join('');
}

function ouvrirFicheMaison(id) {
  const m = id ? trouverMaison(id) : null;
  maisonEnCours = id || null;
  gpsEnCours = m && m.lat != null ? { lat: m.lat, lng: m.lng, precision: null } : null;
  remplirListesSaisie();

  $('maison-titre').textContent = m ? adresseMaison(m) : 'Nouvelle maison';
  const historique = m ? (m.historique || []).slice().sort((a, b) => b.annee - a.annee)
    .map(h => `${h.annee} : ${h.statut === 'don' ? euros(h.don) : (STATUTS[h.statut] ? STATUTS[h.statut].libelle : h.statut)}`).join(' · ') : '';
  $('maison-historique').textContent = [m && m.infos, historique].filter(Boolean).join(' — ');

  // Pour une nouvelle maison, on propose la rue / le lieu de la dernière maison saisie
  const derniere = m ? null : etat.maisons.filter(x => x.passage.modifieLe).sort((a, b) => b.passage.modifieLe.localeCompare(a.passage.modifieLe))[0];
  $('m-numero').value = m ? m.numero : '';
  $('m-voie').value = m ? m.voie : (derniere ? derniere.voie : '');
  $('m-lieu').value = m ? m.lieu : (derniere ? derniere.lieu : '');
  $('m-nom').value = m ? m.nom : '';
  $('m-statut').value = m ? m.passage.statut : 'a_visiter';
  $('m-don').value = m && m.passage.don > 0 ? String(m.passage.don).replace('.', ',') : '';
  $('m-etat').value = m ? m.etat : 'habitee';
  $('m-remarque').value = m ? m.passage.remarque : '';
  $('m-adresse-proposee').hidden = true;
  afficherGpsFiche();

  ouvrirFeuille('feuille-maison');
  if (!m) capturerGps(true);
}

function afficherGpsFiche() {
  $('m-gps-texte').textContent = gpsEnCours
    ? `Position : ✓${gpsEnCours.precision ? ` (± ${Math.round(gpsEnCours.precision)} m)` : ''}`
    : 'Position : —';
}

function capturerGps(silencieux = false) {
  if (!navigator.geolocation) { if (!silencieux) toast('GPS indisponible'); return; }
  $('m-gps-texte').textContent = 'Position : recherche…';
  navigator.geolocation.getCurrentPosition(pos => {
    gpsEnCours = { lat: pos.coords.latitude, lng: pos.coords.longitude, precision: pos.coords.accuracy };
    afficherGpsFiche();
    proposerAdresse(gpsEnCours);
  }, err => {
    afficherGpsFiche();
    if (!silencieux) toast(err.code === 1 ? '📍 Autorisez la localisation pour cette app' : '📍 Position introuvable');
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 });
}

// Adresse la plus proche via la Base Adresse Nationale (seulement si réseau)
async function proposerAdresse(gps) {
  if (!navigator.onLine) return;
  try {
    const rep = await fetch(`https://api-adresse.data.gouv.fr/reverse/?lon=${gps.lng}&lat=${gps.lat}&limit=1`);
    const donnees = await rep.json();
    const p = donnees.features && donnees.features[0] && donnees.features[0].properties;
    if (!p) return;
    const el = $('m-adresse-proposee');
    el.innerHTML = `Adresse proche : <b>${esc(p.label)}</b><br><button type="button" class="btn btn-discret" data-action="utiliser-adresse">Utiliser cette adresse</button>`;
    el.dataset.numero = p.housenumber || '';
    el.dataset.voie = p.street || p.name || '';
    el.hidden = false;
  } catch (e) {
    // Pas grave : l'adresse sera rapprochée sur le PC
  }
}

function utiliserAdresseProposee() {
  const el = $('m-adresse-proposee');
  if (el.dataset.numero) $('m-numero').value = el.dataset.numero;
  if (el.dataset.voie) $('m-voie').value = el.dataset.voie;
  el.hidden = true;
}

function enregistrerMaison() {
  const valeurs = {
    numero: $('m-numero').value.trim(),
    voie: $('m-voie').value.trim(),
    lieu: $('m-lieu').value.trim(),
    nom: $('m-nom').value.trim(),
    etat: $('m-etat').value
  };
  const passage = {
    statut: $('m-statut').value,
    don: lireMontant($('m-don').value),
    remarque: $('m-remarque').value.trim(),
    modifieLe: maintenant()
  };
  if (passage.statut !== 'don') passage.don = 0;

  if (!valeurs.voie && !valeurs.lieu && !gpsEnCours) {
    alerte('Indiquez au moins une rue, un lieu-dit ou la position GPS.');
    return;
  }

  if (maisonEnCours) {
    const m = trouverMaison(maisonEnCours);
    Object.assign(m, valeurs);
    m.passage = passage;
    if (gpsEnCours) { m.lat = gpsEnCours.lat; m.lng = gpsEnCours.lng; }
  } else {
    // Rattacher la nouvelle maison à la commune / aux ordres de la même rue
    const voisine = etat.maisons.find(x => normaliser(x.voie) === normaliser(valeurs.voie) && valeurs.voie)
                 || etat.maisons.find(x => normaliser(x.lieu) === normaliser(valeurs.lieu) && valeurs.lieu);
    etat.maisons.push(preparerMaison({
      ...valeurs,
      id: uid(),
      commune: voisine ? voisine.commune : '',
      ordreLieu: voisine ? voisine.ordreLieu : 999,
      ordreRue: voisine ? voisine.ordreRue : 999,
      lat: gpsEnCours ? gpsEnCours.lat : null,
      lng: gpsEnCours ? gpsEnCours.lng : null,
      nouvelle: true,
      passage
    }));
  }

  sauverEtat();
  fermerFeuilles();
  afficherListe();
  afficherCompteurs();
  if (carte) afficherMarqueurs(false);
  toast(maisonEnCours ? '💾 Enregistré' : '🏠 Nouvelle maison ajoutée');
}

// ============================================================
// AFFICHAGE
// ============================================================
function afficher() {
  if (!etat || !etat.tournee) {
    $('ecran-accueil').hidden = false;
    $('ecran-tournee').hidden = true;
    return;
  }
  $('ecran-accueil').hidden = true;
  $('ecran-tournee').hidden = false;
  const t = etat.tournee;
  $('titre-tournee').textContent = t.nom || 'Tournée';
  $('sous-titre-tournee').textContent = [t.annee, t.responsable ? 'Resp. ' + t.responsable : ''].filter(Boolean).join(' · ');
  afficherCompteurs();
  afficherListe();
  ajusterHauteurEntete();
}

function afficherCompteurs() {
  const maisons = etat.maisons;
  const aVisiter = maisons.filter(estAVisiter).length;
  const concernees = maisons.filter(m => m.etat !== 'inhabitee' && m.etat !== 'disparue').length;
  const faites = concernees - aVisiter;
  const dons = maisons.filter(m => m.passage.statut === 'don');
  const total = dons.reduce((s, m) => s + (m.passage.don || 0), 0);

  $('progression-remplie').style.width = concernees ? `${Math.round(faites / concernees * 100)}%` : '0';
  $('progression-texte').textContent = `${faites} / ${concernees}`;
  $('chiffre-dons').textContent = dons.length;
  $('chiffre-total').textContent = euros(total);
  $('chiffre-repasser').textContent = maisons.filter(m => m.passage.statut === 'repasser' || m.passage.statut === 'absent').length;
  $('chiffre-reste').textContent = aVisiter;

  const n = nbNonEnvoyes();
  $('badge-non-envoye').hidden = n === 0;
  $('badge-non-envoye').textContent = n;
}

function correspondFiltre(m) {
  if (filtre === 'a_visiter') return estAVisiter(m);
  if (filtre === 'repasser') return m.passage.statut === 'repasser' || m.passage.statut === 'absent';
  if (filtre === 'faites') return !estAVisiter(m);
  return true;
}

function correspondRecherche(m) {
  if (!recherche) return true;
  const q = normaliser(recherche);
  return [m.numero, m.voie, m.lieu, m.nom, m.commune, m.passage.remarque, m.infos].some(v => normaliser(v).includes(q));
}

function carteMaisonHTML(m) {
  const s = m.passage.statut;
  const h = dernierHistorique(m);
  const n1 = h ? `${h.annee} : ${h.statut === 'don' ? euros(h.don) : (STATUTS[h.statut] ? STATUTS[h.statut].libelle : esc(h.statut))}` : '';
  const etatBadge = m.etat !== 'habitee' ? `<span class="maison-etat">${esc(ETATS[m.etat])}</span>` : '';
  const nouvelleBadge = m.nouvelle ? '<span class="maison-etat maison-nouvelle">Nouvelle</span>' : '';
  const statutTexte = s === 'don' ? `<b>${esc(euros(m.passage.don))}</b>Don` : (s !== 'a_visiter' ? esc(STATUTS[s].libelle) : '');
  const inactive = m.etat === 'inhabitee' || m.etat === 'disparue';
  const remarque = [m.infos, m.passage.remarque].filter(Boolean).join(' — ');

  return `
    <article class="maison${inactive ? ' inactive' : ''}" data-statut="${esc(s)}" data-id="${esc(m.id)}">
      <div class="maison-haut">
        <div class="maison-infos">
          <div class="maison-adresse">${esc(adresseMaison(m))}${etatBadge}${nouvelleBadge}</div>
          <div class="maison-nom">${esc(m.nom || '—')}</div>
          ${n1 ? `<div class="maison-n1">${esc(n1)}</div>` : ''}
        </div>
        <div class="maison-statut">${statutTexte}</div>
        <button class="btn-detail" data-action="detail" aria-label="Détail">✏️</button>
      </div>
      ${inactive ? '' : `<div class="actions-rapides">
        ${ACTIONS_RAPIDES.map(st => `<button class="action${s === st ? ' actif' : ''}" data-action="statut" data-statut="${st}">${esc(STATUTS[st].court)}</button>`).join('')}
      </div>`}
      ${remarque ? `<div class="maison-remarque">💬 ${esc(remarque)}</div>` : ''}
    </article>`;
}

function afficherListe() {
  const maisons = maisonsTriees().filter(m => correspondFiltre(m) && correspondRecherche(m));
  if (maisons.length === 0) {
    $('vue-liste').innerHTML = `<p class="vide">${recherche || filtre !== 'toutes' ? 'Aucune maison pour ce filtre.' : 'Aucune maison dans cette tournée.'}</p>`;
    return;
  }
  let html = '';
  let dernierLieu = null, derniereVoie = null;
  for (const m of maisons) {
    const lieu = [m.commune, m.lieu].filter(Boolean).join(' — ');
    if (lieu !== dernierLieu) {
      html += `<h2 class="groupe-lieu">📍 ${esc(lieu || 'Sans lieu-dit')}</h2>`;
      dernierLieu = lieu;
      derniereVoie = null;
    }
    if (m.voie && m.voie !== derniereVoie) {
      html += `<h3 class="groupe-voie">${esc(m.voie)}</h3>`;
      derniereVoie = m.voie;
    }
    html += carteMaisonHTML(m);
  }
  $('vue-liste').innerHTML = html;
}

function ajusterHauteurEntete() {
  const h = document.querySelector('.entete').offsetHeight;
  document.documentElement.style.setProperty('--hauteur-entete', h + 'px');
}

// ============================================================
// CARTE
// ============================================================
function afficherVue(vue) {
  document.querySelectorAll('.onglet[data-vue]').forEach(b => b.classList.toggle('actif', b.dataset.vue === vue));
  $('vue-liste').hidden = vue !== 'liste';
  document.querySelector('.barre-outils').hidden = vue !== 'liste';
  $('vue-carte').hidden = vue !== 'carte';
  if (vue === 'carte') initCarte();
}

function initCarte() {
  if (typeof L === 'undefined') {
    $('carte-hors-ligne').hidden = false;
    return;
  }
  $('carte-hors-ligne').hidden = true;
  if (!carte) {
    carte = L.map('carte', { zoomControl: false }).setView([44.47, 2.72], 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap'
    }).addTo(carte);
    coucheMarqueurs = L.layerGroup().addTo(carte);
    afficherMarqueurs(true);
  } else {
    afficherMarqueurs(false);
  }
  setTimeout(() => carte.invalidateSize(), 50);
}

function afficherMarqueurs(cadrer) {
  coucheMarqueurs.clearLayers();
  const points = [];
  for (const m of etat.maisons) {
    if (m.lat == null || m.lng == null) continue;
    const marqueur = L.circleMarker([m.lat, m.lng], {
      radius: 9, weight: 2, color: '#fff', fillOpacity: .95,
      fillColor: COULEURS[m.passage.statut] || COULEURS.autre
    });
    const statut = m.passage.statut === 'don' ? `Don ${euros(m.passage.don)}` : STATUTS[m.passage.statut].libelle;
    marqueur.bindPopup(`<div class="popup-carte"><b>${esc(adresseMaison(m))}</b>${esc(m.nom)}<br>${esc(statut)}<button type="button">Ouvrir</button></div>`);
    // Leaflet bloque la propagation des clics dans les popups : écouteur direct
    marqueur.on('popupopen', (e) => {
      e.popup.getElement().querySelector('button').onclick = () => { carte.closePopup(); ouvrirFicheMaison(m.id); };
    });
    marqueur.addTo(coucheMarqueurs);
    points.push([m.lat, m.lng]);
  }
  if (cadrer && points.length) carte.fitBounds(points, { padding: [40, 40], maxZoom: 17 });
}

function meLocaliser() {
  if (!navigator.geolocation) { toast('GPS indisponible'); return; }
  toast('📍 Recherche de votre position…');
  navigator.geolocation.getCurrentPosition(pos => {
    const ll = [pos.coords.latitude, pos.coords.longitude];
    if (marqueurMoi) marqueurMoi.setLatLng(ll);
    else marqueurMoi = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="position-moi"></div>', iconSize: [18, 18] }) }).addTo(carte);
    carte.setView(ll, Math.max(carte.getZoom(), 17));
  }, err => toast(err.code === 1 ? '📍 Autorisez la localisation pour cette app' : '📍 Position introuvable'),
  { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 });
}

// ============================================================
// FEUILLES
// ============================================================
function ouvrirFeuille(id) {
  fermerFeuilles();
  $(id).hidden = false;
}

function fermerFeuilles() {
  document.querySelectorAll('.feuille-fond').forEach(f => { f.hidden = true; });
}

function ouvrirMenu() {
  $('benevole').value = etat.benevole || '';
  $('menu-dernier-envoi').textContent = etat.dernierEnvoi
    ? `Dernier envoi : ${heure(etat.dernierEnvoi)} · ${nbNonEnvoyes()} saisie(s) depuis`
    : 'Aucun retour envoyé pour l\'instant.';
  ouvrirFeuille('feuille-menu');
}

// ============================================================
// ÉVÉNEMENTS
// ============================================================
function initEvenements() {
  document.addEventListener('click', (e) => {
    const cible = e.target.closest('[data-action], [data-filtre], [data-vue], [data-montant]');
    if (!cible) {
      // Clic sur le fond sombre d'une feuille = fermer
      if (e.target.classList.contains('feuille-fond')) fermerFeuilles();
      return;
    }
    if (cible.dataset.filtre) {
      filtre = cible.dataset.filtre;
      document.querySelectorAll('.filtre').forEach(b => b.classList.toggle('actif', b === cible));
      afficherListe();
      return;
    }
    if (cible.dataset.vue) { afficherVue(cible.dataset.vue); return; }
    if (cible.dataset.montant) { $('don-montant').value = String(cible.dataset.montant).replace('.', ','); return; }

    const idMaison = cible.closest('.maison') && cible.closest('.maison').dataset.id;
    switch (cible.dataset.action) {
      case 'ouvrir-fichier': $('fichier-tournee').click(); break;
      case 'charger-demo': chargerDemo(); break;
      case 'statut': changerStatut(idMaison, cible.dataset.statut); break;
      case 'detail': ouvrirFicheMaison(idMaison); break;
      case 'nouvelle-maison': ouvrirFicheMaison(null); break;
      case 'valider-don': validerDon(); break;
      case 'enregistrer-maison': enregistrerMaison(); break;
      case 'capturer-gps': capturerGps(); break;
      case 'utiliser-adresse': utiliserAdresseProposee(); break;
      case 'fermer-feuille': fermerFeuilles(); break;
      case 'ouvrir-menu': ouvrirMenu(); break;
      case 'envoyer-retour': fermerFeuilles(); envoyerRetour(); break;
      case 'effacer-tournee': effacerTournee(); break;
      case 'me-localiser': meLocaliser(); break;
    }
  });

  $('fichier-tournee').addEventListener('change', (e) => {
    const fichier = e.target.files[0];
    e.target.value = '';
    if (fichier) { fermerFeuilles(); lireFichierChoisi(fichier); }
  });

  let minuteurRecherche = null;
  $('recherche').addEventListener('input', (e) => {
    clearTimeout(minuteurRecherche);
    minuteurRecherche = setTimeout(() => { recherche = e.target.value.trim(); afficherListe(); }, 150);
  });

  $('don-montant').addEventListener('keydown', (e) => { if (e.key === 'Enter') validerDon(); });

  $('benevole').addEventListener('change', (e) => enregistrerBenevole(e.target.value));

  window.addEventListener('resize', () => { if (etat) ajusterHauteurEntete(); });
}

// ============================================================
// DÉMARRAGE
// ============================================================
function init() {
  $('version-app').textContent = APP_VERSION;
  $('version-accueil').textContent = APP_VERSION;
  remplirSelects();
  chargerEtat();
  initEvenements();
  afficher();
  ouvrirFichierPartage();

  // Demander au navigateur de ne pas effacer nos données en cas de manque de place
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('Service worker non enregistré', e));
  }
}

init();
