/* ============================================================
   bulletins.js — Module Bulletin de Salaire
   Génère et imprime un bulletin de paie individuel par employé
   ============================================================ */

/* ---------------------------------------------------------------
   CALCUL DU BULLETIN
   Données sources :
   - Travaux : activités réalisées par le conducteur (champ conducteur)
   - Charges  : lignes de catégorie "salaire" liées à l'employé (primes,
                avances, retenues saisies manuellement)
   - Paramètres : salaireOperation (taux par opération)
   --------------------------------------------------------------- */

/**
 * Calcule toutes les rubriques du bulletin pour un employé donné
 * sur une période [dateDebut, dateFin] (format YYYY-MM-DD).
 *
 * @param {string} employeId
 * @param {string} dateDebut  YYYY-MM-DD
 * @param {string} dateFin    YYYY-MM-DD
 * @returns {Object} données complètes du bulletin
 */
function calculerBulletin(employeId, dateDebut, dateFin) {
  const emp = employeById(employeId);
  if (!emp) return null;

  const range = [dateDebut, dateFin];
  const taux  = Number(DB.settings.salaireOperation) || 500;

  /* --- Travaux du conducteur sur la période --- */
  const travaux = rowsPour('travaux').filter(t =>
    t.conducteur === employeId && inRange(t.date, range)
  );

  let nbTransferts   = 0;
  let nbOuvertures   = 0;
  let nbAutres       = 0;
  let caGenere       = 0;

  travaux.forEach(t => {
    const ops = opsTravail(t);
    nbTransferts += ops.transferts;
    nbOuvertures += ops.ouvertures;
    nbAutres     += Math.max(0, (Number(t.qte) || 0) - ops.transferts - ops.ouvertures);
    caGenere     += trvMontant(t);
  });

  const nbOps      = nbTransferts + nbOuvertures;
  const salaireBrut = Math.round(nbOps * taux * 100) / 100;

  /* --- Charges "salaire" liées à l'employé sur la période ---
     On distingue primes (montant > 0) et retenues (montant < 0) s'il y en a.
     Convention retenue dans les formulaires :
       - avance / retenue saisie avec montant négatif OU libellé "retenue / avance"
       - prime saisie avec montant positif
  */
  const chargesSalaire = rowsPour('charges').filter(c =>
    c.categorie === 'salaire' && c.employeId === employeId && inRange(c.date, range)
  );

  let primes   = 0;
  let retenues = 0;
  const lignesSuppl = [];

  chargesSalaire.forEach(c => {
    const m = Number(c.montant) || 0;
    const lib = (c.libelle || c.notes || '').toLowerCase();
    const estRetenue = m < 0 || lib.includes('retenu') || lib.includes('avance') || lib.includes('déduct');
    if (estRetenue) {
      retenues += Math.abs(m);
      lignesSuppl.push({ type: 'retenue', libelle: c.libelle || 'Retenue', montant: -Math.abs(m), date: c.date });
    } else if (m > 0) {
      primes += m;
      lignesSuppl.push({ type: 'prime', libelle: c.libelle || 'Prime / bonus', montant: m, date: c.date });
    }
  });

  const salaireNet = Math.round((salaireBrut + primes - retenues) * 100) / 100;

  /* --- Récapitulatif par activité --- */
  const parActivite = {};
  travaux.forEach(t => {
    const a = activiteById(t.activiteId);
    const key = a ? a.libelle : 'Autre';
    if (!parActivite[key]) {
      parActivite[key] = {
        libelle: key,
        unite: a ? a.unite : 'unité',
        qte: 0,
        ca: 0
      };
    }
    parActivite[key].qte += Number(t.qte) || 0;
    parActivite[key].ca  += trvMontant(t);
  });

  return {
    employe: emp,
    periode: { debut: dateDebut, fin: dateFin },
    taux,
    nbTravaux: travaux.length,
    nbTransferts,
    nbOuvertures,
    nbAutres,
    nbOps,
    caGenere: Math.round(caGenere * 100) / 100,
    salaireBrut,
    primes: Math.round(primes * 100) / 100,
    retenues: Math.round(retenues * 100) / 100,
    salaireNet,
    lignesSuppl,
    parActivite: Object.values(parActivite),
    entreprise: DB.settings.nom || 'Mon Entreprise',
    devise: DB.settings.devise || 'FCFA'
  };
}

/* ---------------------------------------------------------------
   RENDU HTML DU BULLETIN (prévisualisation + impression)
   --------------------------------------------------------------- */

/**
 * Génère le HTML complet du bulletin de salaire (format A4).
 * Ce HTML est utilisé à la fois pour la prévisualisation dans l'app
 * et pour l'impression via window.print().
 */
function htmlBulletin(b) {
  if (!b) return '<p class="muted">Aucune donnée.</p>';

  const nomEnt  = escapeHTML(b.entreprise);
  const nomEmp  = escapeHTML(b.employe.nom);
  const roleEmp = b.employe.role === 'conducteur' ? 'Conducteur' :
                  b.employe.role === 'apprenti'   ? 'Apprenti'   : 'Personnel';

  const moisDebut = frDate(b.periode.debut);
  const moisFin   = frDate(b.periode.fin);
  const periodeLabel = moisDebut === moisFin ? moisDebut : `Du ${moisDebut} au ${moisFin}`;
  const numBulletin = `BS-${b.periode.debut.slice(0,7).replace('-','')}-${b.employe.id.slice(-4).toUpperCase()}`;

  /* Lignes d'activités */
  const lignesActHTML = b.parActivite.length ? b.parActivite.map(a => `
    <tr>
      <td>${escapeHTML(a.libelle)}</td>
      <td class="bl-num">${fmtNum(a.qte)}</td>
      <td class="bl-num">${escapeHTML(a.unite)}</td>
      <td class="bl-num">${money(b.taux)}</td>
      <td class="bl-num">${money(Math.round(a.qte * b.taux * 100) / 100)}</td>
    </tr>`).join('') :
    '<tr><td colspan="5" style="color:#999;font-style:italic;">Aucun travail enregistré sur cette période</td></tr>';

  /* Lignes supplémentaires (primes / retenues) */
  const lignesSupplHTML = b.lignesSuppl.map(l => `
    <tr>
      <td>${escapeHTML(l.libelle)}</td>
      <td class="bl-num" colspan="3">${frDate(l.date)}</td>
      <td class="bl-num ${l.montant >= 0 ? 'bl-green' : 'bl-red'}">${l.montant >= 0 ? '+' : ''}${money(l.montant)}</td>
    </tr>`).join('');

  const today_ = frDate(today());

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Bulletin de salaire — ${nomEmp}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: "Segoe UI", Arial, sans-serif;
    font-size: 12px;
    color: #1a2340;
    background: #fff;
  }
  .bl-page { max-width: 780px; margin: 0 auto; padding: 0; }

  /* En-tête */
  .bl-header {
    display: flex; justify-content: space-between; align-items: flex-start;
    border-bottom: 3px solid #1a2340; padding-bottom: 14px; margin-bottom: 18px;
  }
  .bl-logo { font-size: 28px; margin-bottom: 4px; }
  .bl-company { font-size: 18px; font-weight: 700; color: #1a2340; }
  .bl-subtitle { font-size: 11px; color: #666; margin-top: 2px; }
  .bl-meta { text-align: right; }
  .bl-meta h1 { font-size: 20px; font-weight: 700; color: #4f8cff; }
  .bl-meta .bl-num-doc { font-size: 11px; color: #888; margin-top: 4px; }
  .bl-meta .bl-periode {
    font-size: 12px; font-weight: 600; color: #1a2340;
    background: #eef4ff; border-radius: 8px; padding: 5px 12px; margin-top: 8px;
  }

  /* Fiche employé */
  .bl-section { margin-bottom: 18px; }
  .bl-section-title {
    font-size: 11px; font-weight: 700; text-transform: uppercase;
    letter-spacing: .6px; color: #4f8cff; border-bottom: 1px solid #d0daf5;
    padding-bottom: 5px; margin-bottom: 10px;
  }
  .bl-info-grid {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px 18px;
  }
  .bl-info-item .label { font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: .3px; }
  .bl-info-item .val { font-size: 13px; font-weight: 600; color: #1a2340; margin-top: 2px; }

  /* Tableau des rubriques */
  table { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
  th {
    background: #1a2340; color: #fff; font-size: 10.5px; font-weight: 600;
    text-align: left; padding: 7px 10px; text-transform: uppercase; letter-spacing: .3px;
  }
  td { padding: 7px 10px; border-bottom: 1px solid #e8edf8; font-size: 12px; }
  tr:last-child td { border-bottom: none; }
  .bl-num { text-align: right; font-variant-numeric: tabular-nums; }
  .bl-green { color: #1a9e6e; font-weight: 600; }
  .bl-red   { color: #d63645; font-weight: 600; }
  .bl-alt   { background: #f7f9ff; }

  /* Totaux */
  .bl-totaux {
    border: 2px solid #1a2340; border-radius: 10px; overflow: hidden; margin-top: 14px;
  }
  .bl-tot-row {
    display: flex; justify-content: space-between; align-items: center;
    padding: 9px 16px; border-bottom: 1px solid #e0e8f5;
  }
  .bl-tot-row:last-child { border-bottom: none; }
  .bl-tot-row.net {
    background: #1a2340; color: #fff; font-size: 15px; font-weight: 700;
  }
  .bl-tot-row .t-label { color: #555; font-size: 12px; }
  .bl-tot-row.net .t-label { color: #a0b8e0; }
  .bl-tot-row .t-val { font-size: 13px; font-weight: 700; }
  .bl-tot-row.net .t-val { font-size: 18px; }

  /* Montant en lettres */
  .bl-lettres {
    margin-top: 12px; padding: 10px 14px; background: #f0f6ff;
    border-left: 4px solid #4f8cff; border-radius: 0 8px 8px 0;
    font-size: 11.5px; color: #2a3f70;
  }
  .bl-lettres strong { display: block; font-size: 10px; text-transform: uppercase; color: #888; margin-bottom: 3px; }

  /* Signature */
  .bl-signatures {
    display: grid; grid-template-columns: 1fr 1fr 1fr;
    gap: 20px; margin-top: 32px; padding-top: 18px;
    border-top: 1px dashed #c5cfe0;
  }
  .bl-sig-box { text-align: center; }
  .bl-sig-box .sig-line { border-bottom: 1px solid #1a2340; height: 50px; margin-bottom: 6px; }
  .bl-sig-box .sig-label { font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: .4px; }

  /* Pied de page */
  .bl-footer {
    margin-top: 24px; padding-top: 10px; border-top: 1px solid #d0daf5;
    font-size: 9.5px; color: #aaa; text-align: center;
  }

  @media print {
    body { background: #fff; }
    .bl-page { max-width: 100%; }
    .no-print { display: none !important; }
  }
</style>
</head>
<body>
<div class="bl-page">

  <!-- EN-TÊTE -->
  <div class="bl-header">
    <div>
      <div class="bl-logo">🚜</div>
      <div class="bl-company">${nomEnt}</div>
      <div class="bl-subtitle">Gestion des engins — Transferts &amp; Débardage</div>
    </div>
    <div class="bl-meta">
      <h1>Bulletin de Salaire</h1>
      <div class="bl-num-doc">Réf. : ${escapeHTML(numBulletin)}</div>
      <div class="bl-periode">📅 ${escapeHTML(periodeLabel)}</div>
    </div>
  </div>

  <!-- FICHE EMPLOYÉ -->
  <div class="bl-section">
    <div class="bl-section-title">Informations employé</div>
    <div class="bl-info-grid">
      <div class="bl-info-item">
        <div class="label">Nom complet</div>
        <div class="val">${nomEmp}</div>
      </div>
      <div class="bl-info-item">
        <div class="label">Fonction</div>
        <div class="val">${escapeHTML(roleEmp)}</div>
      </div>
      <div class="bl-info-item">
        <div class="label">Taux par opération</div>
        <div class="val">${money(b.taux)}</div>
      </div>
      <div class="bl-info-item">
        <div class="label">Période</div>
        <div class="val">${escapeHTML(periodeLabel)}</div>
      </div>
      <div class="bl-info-item">
        <div class="label">Nb. de travaux</div>
        <div class="val">${b.nbTravaux}</div>
      </div>
      <div class="bl-info-item">
        <div class="label">Date d'édition</div>
        <div class="val">${today_}</div>
      </div>
    </div>
  </div>

  <!-- DÉTAIL DES ACTIVITÉS -->
  <div class="bl-section">
    <div class="bl-section-title">Détail des activités</div>
    <table>
      <thead>
        <tr>
          <th>Activité</th>
          <th class="bl-num">Quantité</th>
          <th class="bl-num">Unité</th>
          <th class="bl-num">Taux unitaire</th>
          <th class="bl-num">Montant</th>
        </tr>
      </thead>
      <tbody>
        ${lignesActHTML}
        ${b.nbTransferts || b.nbOuvertures ? `
        <tr class="bl-alt">
          <td colspan="4" style="font-size:11px;color:#555;">Total opérations rémunérées (transferts + ouvertures)</td>
          <td class="bl-num" style="font-weight:700;">${fmtNum(b.nbOps)} op.</td>
        </tr>` : ''}
      </tbody>
    </table>
  </div>

  ${b.lignesSuppl.length ? `
  <!-- PRIMES / RETENUES -->
  <div class="bl-section">
    <div class="bl-section-title">Primes, avances &amp; retenues</div>
    <table>
      <thead>
        <tr>
          <th>Libellé</th>
          <th class="bl-num" colspan="3">Date</th>
          <th class="bl-num">Montant</th>
        </tr>
      </thead>
      <tbody>
        ${lignesSupplHTML}
      </tbody>
    </table>
  </div>` : ''}

  <!-- RÉCAPITULATIF -->
  <div class="bl-section">
    <div class="bl-section-title">Récapitulatif</div>
    <div class="bl-totaux">
      <div class="bl-tot-row">
        <span class="t-label">💼 CA généré</span>
        <span class="t-val">${money(b.caGenere)}</span>
      </div>
      <div class="bl-tot-row">
        <span class="t-label">🔢 Transferts</span>
        <span class="t-val">${fmtNum(b.nbTransferts)}</span>
      </div>
      <div class="bl-tot-row">
        <span class="t-label">🪵 Ouvertures / Débardages</span>
        <span class="t-val">${fmtNum(b.nbOuvertures)}</span>
      </div>
      <div class="bl-tot-row">
        <span class="t-label">💰 Salaire brut (${fmtNum(b.nbOps)} op. × ${money(b.taux)})</span>
        <span class="t-val">${money(b.salaireBrut)}</span>
      </div>
      ${b.primes > 0 ? `<div class="bl-tot-row">
        <span class="t-label">➕ Primes &amp; bonus</span>
        <span class="t-val bl-green">+${money(b.primes)}</span>
      </div>` : ''}
      ${b.retenues > 0 ? `<div class="bl-tot-row">
        <span class="t-label">➖ Retenues &amp; avances</span>
        <span class="t-val bl-red">-${money(b.retenues)}</span>
      </div>` : ''}
      <div class="bl-tot-row net">
        <span class="t-label">NET À PAYER</span>
        <span class="t-val">${money(b.salaireNet)}</span>
      </div>
    </div>

    <div class="bl-lettres">
      <strong>Montant en lettres</strong>
      ${escapeHTML(montantEnLettres(b.salaireNet))}
    </div>
  </div>

  <!-- SIGNATURES -->
  <div class="bl-signatures">
    <div class="bl-sig-box">
      <div class="sig-line"></div>
      <div class="sig-label">Directeur / Patron</div>
    </div>
    <div class="bl-sig-box">
      <div class="sig-line"></div>
      <div class="sig-label">Responsable RH</div>
    </div>
    <div class="bl-sig-box">
      <div class="sig-line"></div>
      <div class="sig-label">Signature employé<br>Lu et approuvé</div>
    </div>
  </div>

  <!-- PIED DE PAGE -->
  <div class="bl-footer">
    Document généré par ${escapeHTML(nomEnt)} · ${today_} — Ne vaut pas contrat de travail
  </div>

</div>
</body>
</html>`;
}

/* ---------------------------------------------------------------
   IMPRESSION / EXPORT
   --------------------------------------------------------------- */

/**
 * Ouvre une fenêtre popup et lance l'impression du bulletin.
 * @param {Object} b  résultat de calculerBulletin()
 */
function imprimerBulletin(b) {
  const html = htmlBulletin(b);
  const win  = window.open('', '_blank', 'width=900,height=700');
  if (!win) {
    toast('Fenêtre bloquée — autorisez les popups pour ce site', true);
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.onload = () => {
    win.focus();
    win.print();
  };
}

/**
 * Exporte le bulletin de salaire au format Word (.doc) structuré.
 * @param {Object} b résultat de calculerBulletin()
 */
function telechargerBulletinWord(b) {
  if (!b) return;
  const nomEmp = (b.employe && b.employe.nom) ? b.employe.nom : 'Employe';
  const roleEmp = (b.employe && b.employe.role === 'conducteur') ? 'Conducteur' :
                  (b.employe && b.employe.role === 'apprenti')   ? 'Apprenti'   : 'Personnel';
  const moisDebut = frDate(b.periode.debut);
  const moisFin   = frDate(b.periode.fin);
  const periodeLabel = moisDebut === moisFin ? moisDebut : `Du ${moisDebut} au ${moisFin}`;
  const filename = `bulletin_${nomEmp.replace(/\s+/g, '_')}_${b.periode.debut.slice(0,7).replace('-','_')}.doc`;

  const lignesAct = b.parActivite.length ? b.parActivite.map(a => `
    <tr>
      <td style="padding:6px 10px; border:1px solid #d0daf5;">${escapeHTML(a.libelle)}</td>
      <td style="padding:6px 10px; border:1px solid #d0daf5; text-align:right;">${fmtNum(a.qte)}</td>
      <td style="padding:6px 10px; border:1px solid #d0daf5; text-align:center;">${escapeHTML(a.unite)}</td>
      <td style="padding:6px 10px; border:1px solid #d0daf5; text-align:right;">${money(b.taux)}</td>
      <td style="padding:6px 10px; border:1px solid #d0daf5; text-align:right; font-weight:bold;">${money(Math.round(a.qte * b.taux * 100) / 100)}</td>
    </tr>`).join('') : '<tr><td colspan="5" style="padding:8px; border:1px solid #d0daf5; color:#777; font-style:italic;">Aucun travail enregistré</td></tr>';

  const lignesSuppl = b.lignesSuppl.length ? b.lignesSuppl.map(l => `
    <tr>
      <td style="padding:6px 10px; border:1px solid #d0daf5;">${escapeHTML(l.libelle)}</td>
      <td style="padding:6px 10px; border:1px solid #d0daf5; text-align:center;" colspan="3">${frDate(l.date)}</td>
      <td style="padding:6px 10px; border:1px solid #d0daf5; text-align:right; font-weight:bold; color:${l.montant >= 0 ? '#1a9e6e' : '#d63645'};">${l.montant >= 0 ? '+' : ''}${money(l.montant)}</td>
    </tr>`).join('') : '';

  const content = `
  <table style="width:100%; border:none; margin-bottom:14px; border-bottom:3px solid #1a2340; padding-bottom:8px;">
    <tr>
      <td style="border:none; vertical-align:top;">
        <div style="font-size:16pt; font-weight:bold; color:#1a2340;">${escapeHTML(b.entreprise)}</div>
        <div style="font-size:9.5pt; color:#666;">Gestion des engins — Transferts &amp; Débardage</div>
      </td>
      <td style="border:none; text-align:right; vertical-align:top;">
        <div style="font-size:18pt; font-weight:bold; color:#4f8cff;">BULLETIN DE SALAIRE</div>
        <div style="font-size:10pt; font-weight:bold; color:#1a2340; margin-top:4px;">${escapeHTML(periodeLabel)}</div>
      </td>
    </tr>
  </table>

  <table style="width:100%; border:1px solid #d0daf5; background:#f6f8fc; margin-bottom:16px;">
    <tr>
      <td style="border:none; padding:8px 12px;"><b>Nom :</b> ${escapeHTML(nomEmp)}</td>
      <td style="border:none; padding:8px 12px;"><b>Fonction :</b> ${escapeHTML(roleEmp)}</td>
      <td style="border:none; padding:8px 12px;"><b>Taux / opération :</b> ${money(b.taux)}</td>
    </tr>
  </table>

  <h3 style="font-size:11.5pt; color:#1a2340; margin:14px 0 6px;">1. Activités &amp; Opérations Réalisées</h3>
  <table style="width:100%; border-collapse:collapse; margin-bottom:12px;">
    <thead>
      <tr style="background:#1a2340; color:#ffffff;">
        <th style="padding:7px 10px; border:1px solid #1a2340; text-align:left;">Activité</th>
        <th style="padding:7px 10px; border:1px solid #1a2340; text-align:right;">Quantité</th>
        <th style="padding:7px 10px; border:1px solid #1a2340; text-align:center;">Unité</th>
        <th style="padding:7px 10px; border:1px solid #1a2340; text-align:right;">Taux</th>
        <th style="padding:7px 10px; border:1px solid #1a2340; text-align:right;">Montant</th>
      </tr>
    </thead>
    <tbody>
      ${lignesAct}
      <tr style="background:#f0f4fa; font-weight:bold;">
        <td colspan="4" style="padding:6px 10px; border:1px solid #d0daf5;">Total opérations rémunérées</td>
        <td style="padding:6px 10px; border:1px solid #d0daf5; text-align:right;">${fmtNum(b.nbOps)} op.</td>
      </tr>
    </tbody>
  </table>

  ${b.lignesSuppl.length ? `
  <h3 style="font-size:11.5pt; color:#1a2340; margin:14px 0 6px;">2. Primes, Avances &amp; Retenues</h3>
  <table style="width:100%; border-collapse:collapse; margin-bottom:12px;">
    <thead>
      <tr style="background:#1a2340; color:#ffffff;">
        <th style="padding:7px 10px; border:1px solid #1a2340; text-align:left;">Libellé</th>
        <th style="padding:7px 10px; border:1px solid #1a2340; text-align:center;" colspan="3">Date</th>
        <th style="padding:7px 10px; border:1px solid #1a2340; text-align:right;">Montant</th>
      </tr>
    </thead>
    <tbody>
      ${lignesSuppl}
    </tbody>
  </table>` : ''}

  <h3 style="font-size:11.5pt; color:#1a2340; margin:14px 0 6px;">3. Récapitulatif Financier</h3>
  <table style="width:100%; border-collapse:collapse; border:2px solid #1a2340; margin-bottom:14px;">
    <tr>
      <td style="padding:7px 10px; border:1px solid #e0e8f5;"><b>CA généré par le travailleur :</b></td>
      <td style="padding:7px 10px; border:1px solid #e0e8f5; text-align:right;"><b>${money(b.caGenere)}</b></td>
    </tr>
    <tr>
      <td style="padding:7px 10px; border:1px solid #e0e8f5;">Salaire brut (${fmtNum(b.nbOps)} op. × ${money(b.taux)}) :</td>
      <td style="padding:7px 10px; border:1px solid #e0e8f5; text-align:right;">${money(b.salaireBrut)}</td>
    </tr>
    ${b.primes > 0 ? `
    <tr>
      <td style="padding:7px 10px; border:1px solid #e0e8f5; color:#1a9e6e;">+ Primes &amp; bonus :</td>
      <td style="padding:7px 10px; border:1px solid #e0e8f5; text-align:right; font-weight:bold; color:#1a9e6e;">+${money(b.primes)}</td>
    </tr>` : ''}
    ${b.retenues > 0 ? `
    <tr>
      <td style="padding:7px 10px; border:1px solid #e0e8f5; color:#d63645;">- Retenues &amp; avances :</td>
      <td style="padding:7px 10px; border:1px solid #e0e8f5; text-align:right; font-weight:bold; color:#d63645;">-${money(b.retenues)}</td>
    </tr>` : ''}
    <tr style="background:#1a2340; color:#ffffff; font-size:13pt; font-weight:bold;">
      <td style="padding:10px;">NET À PAYER :</td>
      <td style="padding:10px; text-align:right;">${money(b.salaireNet)}</td>
    </tr>
  </table>

  <div style="padding:8px 12px; background:#f0f6ff; border-left:4px solid #4f8cff; font-size:10.5pt; margin-bottom:30px;">
    <b>Montant en toutes lettres :</b> ${escapeHTML(montantEnLettres(b.salaireNet))}
  </div>

  <table style="width:100%; border:none; margin-top:25px;">
    <tr>
      <td style="border:none; text-align:center; width:33%;">
        <div style="border-bottom:1px solid #1a2340; height:45px; margin-bottom:5px;"></div>
        <div style="font-size:9pt; text-transform:uppercase; color:#666;">Le Directeur</div>
      </td>
      <td style="border:none; width:33%;"></td>
      <td style="border:none; text-align:center; width:33%;">
        <div style="border-bottom:1px solid #1a2340; height:45px; margin-bottom:5px;"></div>
        <div style="font-size:9pt; text-transform:uppercase; color:#666;">Signature Travailleur<br>(Lu et approuvé)</div>
      </td>
    </tr>
  </table>
  `;

  exportDOC(filename, 'Bulletin de salaire — ' + nomEmp, content);
}



/* ---------------------------------------------------------------
   VUE BULLETINS — UI complète
   --------------------------------------------------------------- */

/**
 * Remplit la section "Bulletins de salaire".
 * Appelé par renderView('bulletins').
 */
function renderBulletins() {
  _fillBulletinSelects();
  _updateBulletinPreview();
  _renderBulletinsTable();
}

function _fillBulletinSelects() {
  const sel = $('#bulEmploye');
  if (!sel) return;
  const ancien = sel.value;
  sel.innerHTML = '<option value="">— Choisir un employé —</option>' +
    optionHTML(DB.employes, 'id', 'nom', ancien);
  if (ancien) sel.value = ancien;

  /* Mois par défaut = mois en cours */
  const bulMois = $('#bulMois');
  if (bulMois && !bulMois.value) {
    const now = new Date();
    bulMois.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }
}

function _parseMoisRange(moisStr) {
  /* moisStr = "YYYY-MM" → [début, fin] */
  if (!moisStr) {
    const now = new Date();
    moisStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }
  const [y, m] = moisStr.split('-').map(Number);
  const fin = new Date(y, m, 0); /* dernier jour du mois */
  const pad = n => String(n).padStart(2, '0');
  return [
    `${y}-${pad(m)}-01`,
    `${y}-${pad(m)}-${pad(fin.getDate())}`
  ];
}

function _buildCurrentBulletin() {
  const empId  = $('#bulEmploye') ? $('#bulEmploye').value : '';
  const moisStr = $('#bulMois')    ? $('#bulMois').value    : '';
  if (!empId) return null;
  const [debut, fin] = _parseMoisRange(moisStr);
  return calculerBulletin(empId, debut, fin);
}

function _updateBulletinPreview() {
  const preview = $('#bulPreview');
  if (!preview) return;

  const b = _buildCurrentBulletin();
  if (!b) {
    preview.innerHTML = '<p class="muted" style="padding:20px;">Choisissez un employé pour générer l\'aperçu.</p>';
    _setBulletinActions(false);
    return;
  }

  /* Rendu simplifié dans l'application (pas le HTML complet imprimable) */
  const periodeLabel = `${frDate(b.periode.debut)} → ${frDate(b.periode.fin)}`;

  const lignesActHTML = b.parActivite.length
    ? b.parActivite.map((a, i) => `
      <tr class="${i % 2 === 0 ? '' : 'tr-alt'}">
        <td>${escapeHTML(a.libelle)}</td>
        <td class="num">${fmtNum(a.qte)} ${escapeHTML(a.unite)}</td>
        <td class="num">${money(b.taux)}</td>
        <td class="num">${money(Math.round(a.qte * b.taux * 100) / 100)}</td>
      </tr>`).join('')
    : '<tr><td colspan="4" class="muted">Aucun travail sur la période</td></tr>';

  const lignesSupplHTML = b.lignesSuppl.map(l => `
    <tr>
      <td>${escapeHTML(l.libelle)} <span class="muted">(${frDate(l.date)})</span></td>
      <td class="num" colspan="2">${l.montant >= 0 ? 'Prime / Bonus' : 'Retenue / Avance'}</td>
      <td class="num ${l.montant >= 0 ? 'pos' : 'neg'}">${l.montant >= 0 ? '+' : ''}${money(l.montant)}</td>
    </tr>`).join('');

  preview.innerHTML = `
    <div class="bul-preview-header">
      <div class="bul-emp-name">👤 ${escapeHTML(b.employe.nom)}</div>
      <div class="bul-emp-role muted">${escapeHTML(b.employe.role === 'conducteur' ? 'Conducteur' : b.employe.role === 'apprenti' ? 'Apprenti' : 'Personnel')}</div>
      <div class="bul-periode muted">📅 ${periodeLabel}</div>
    </div>

    <div class="bul-kpis">
      <div class="bul-kpi"><div class="bk-label">CA généré</div><div class="bk-val pos">${money(b.caGenere)}</div></div>
      <div class="bul-kpi"><div class="bk-label">🚛 Transferts</div><div class="bk-val">${fmtNum(b.nbTransferts)}</div></div>
      <div class="bul-kpi"><div class="bk-label">🪵 Ouvertures</div><div class="bk-val">${fmtNum(b.nbOuvertures)}</div></div>
      <div class="bul-kpi accent-green"><div class="bk-label">Net à payer</div><div class="bk-val">${money(b.salaireNet)}</div></div>
    </div>

    <h3 style="font-size:13px;margin:14px 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;">Détail des activités</h3>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>Activité</th><th class="num">Quantité</th><th class="num">Taux</th><th class="num">Montant</th></tr></thead>
        <tbody>${lignesActHTML}</tbody>
      </table>
    </div>

    ${b.lignesSuppl.length ? `
    <h3 style="font-size:13px;margin:14px 0 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;">Primes / Retenues</h3>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>Libellé</th><th class="num" colspan="2">Type</th><th class="num">Montant</th></tr></thead>
        <tbody>${lignesSupplHTML}</tbody>
      </table>
    </div>` : ''}

    <div class="bul-recap">
      <div class="bul-recap-row"><span>Salaire brut</span><span class="num">${money(b.salaireBrut)}</span></div>
      ${b.primes > 0 ? `<div class="bul-recap-row"><span>+ Primes</span><span class="num pos">+${money(b.primes)}</span></div>` : ''}
      ${b.retenues > 0 ? `<div class="bul-recap-row"><span>- Retenues</span><span class="num neg">-${money(b.retenues)}</span></div>` : ''}
      <div class="bul-recap-row bul-net"><span>NET À PAYER</span><span class="num">${money(b.salaireNet)}</span></div>
      <div class="bul-lettres">${escapeHTML(montantEnLettres(b.salaireNet))}</div>
    </div>
  `;

  _setBulletinActions(true);
}

function _setBulletinActions(enabled) {
  const btn = $('#bulBtnImprimer');
  if (btn) btn.disabled = !enabled;
  const btnDoc = $('#bulBtnWord');
  if (btnDoc) btnDoc.disabled = !enabled;
}

/**
 * Remplit le tableau recapitulatif de tous les employes pour le mois selectionne.
 */
function _renderBulletinsTable() {
  const moisEl  = $('#bulMois');
  const moisStr = moisEl ? moisEl.value : '';
  const [debut, fin] = _parseMoisRange(moisStr);

  const lbl = $('#bulMoisLabel');
  if (lbl && moisStr) {
    const moisNoms = ['Janvier','F\u00e9vrier','Mars','Avril','Mai','Juin','Juillet','Ao\u00fbt','Septembre','Octobre','Novembre','D\u00e9cembre'];
    const [y, m] = moisStr.split('-').map(Number);
    lbl.textContent = moisNoms[m - 1] + ' ' + y;
  }

  const tbody = $('#tableBulletins tbody');
  const tfoot = $('#tableBulletins tfoot');
  if (!tbody) return;

  if (!DB.employes.length) {
    tbody.innerHTML = '<tr><td colspan="11" class="muted">Aucun employ\u00e9 enregistr\u00e9. Ajoutez-les dans Param\u00e8tres \u2192 Personnel.</td></tr>';
    if (tfoot) tfoot.innerHTML = '';
    return;
  }

  let totTransf = 0, totOuv = 0, totOps = 0, totBrut = 0, totPrimes = 0, totRet = 0, totNet = 0, totCA = 0;

  tbody.innerHTML = DB.employes.map(emp => {
    const b = calculerBulletin(emp.id, debut, fin);
    if (!b) return '';
    totTransf += b.nbTransferts; totOuv += b.nbOuvertures; totOps += b.nbOps;
    totBrut   += b.salaireBrut;  totPrimes += b.primes;    totRet  += b.retenues;
    totNet    += b.salaireNet;   totCA     += b.caGenere;
    const roleLabel = emp.role === 'conducteur' ? 'Conducteur' : emp.role === 'apprenti' ? 'Apprenti' : 'Autre';
    return `<tr>
      <td><b>${escapeHTML(emp.nom)}</b></td>
      <td><span class="badge b-salaire">${escapeHTML(roleLabel)}</span></td>
      <td class="num">${fmtNum(b.nbTransferts)}</td>
      <td class="num">${fmtNum(b.nbOuvertures)}</td>
      <td class="num">${fmtNum(b.nbOps)}</td>
      <td class="num pos">${money(b.caGenere)}</td>
      <td class="num">${money(b.salaireBrut)}</td>
      <td class="num ${b.primes > 0 ? 'pos' : ''}">${b.primes > 0 ? '+' + money(b.primes) : '\u2014'}</td>
      <td class="num ${b.retenues > 0 ? 'neg' : ''}">${b.retenues > 0 ? '-' + money(b.retenues) : '\u2014'}</td>
      <td class="num pos" style="font-weight:700">${money(b.salaireNet)}</td>
      <td style="white-space:nowrap">
        <button class="btn-icon" title="Aper\u00e7u" onclick="(function(){$('#bulEmploye').value='${emp.id}';_updateBulletinPreview();window.scrollTo({top:0,behavior:'smooth'});})()">&#128065;</button>
        <button class="btn-icon" data-priv="rapports:vue" title="Imprimer" onclick="(function(){var b2=calculerBulletin('${emp.id}','${debut}','${fin}');if(b2)imprimerBulletin(b2);})()">&#128424;</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="11" class="muted">Aucun employ\u00e9.</td></tr>';

  if (tfoot) {
    tfoot.innerHTML = `<tr>
      <td colspan="2"><b>TOTAL</b></td>
      <td class="num"><b>${fmtNum(totTransf)}</b></td>
      <td class="num"><b>${fmtNum(totOuv)}</b></td>
      <td class="num"><b>${fmtNum(totOps)}</b></td>
      <td class="num pos"><b>${money(totCA)}</b></td>
      <td class="num"><b>${money(totBrut)}</b></td>
      <td class="num pos"><b>${totPrimes > 0 ? '+' + money(totPrimes) : '\u2014'}</b></td>
      <td class="num neg"><b>${totRet > 0 ? '-' + money(totRet) : '\u2014'}</b></td>
      <td class="num pos"><b>${money(totNet)}</b></td>
      <td></td>
    </tr>`;
  }
}


/* ---------------------------------------------------------------
   INIT
   --------------------------------------------------------------- */

function initBulletins() {
  const sel   = $('#bulEmploye');
  const mois  = $('#bulMois');
  const btnImp = $('#bulBtnImprimer');
  const btnAp  = $('#bulBtnApercu');

  if (sel)  sel.addEventListener('change',  () => { _updateBulletinPreview(); _renderBulletinsTable(); });
  if (mois) mois.addEventListener('change', () => { _updateBulletinPreview(); _renderBulletinsTable(); });

  if (btnAp) {
    btnAp.addEventListener('click', () => {
      _updateBulletinPreview();
    });
  }

  if (btnImp) {
    btnImp.addEventListener('click', () => {
      if (!requirePriv('rapports:vue')) return;
      const b = _buildCurrentBulletin();
      if (!b) { toast('Choisissez d\'abord un employé', true); return; }
      imprimerBulletin(b);
    });
  }

  const btnDoc = $('#bulBtnWord');
  if (btnDoc) {
    btnDoc.addEventListener('click', () => {
      if (!requirePriv('rapports:vue')) return;
      const b = _buildCurrentBulletin();
      if (!b) { toast('Choisissez d\'abord un employé', true); return; }
      telechargerBulletinWord(b);
    });
  }

  /* Export Excel (.xls) de tous les bulletins du mois */
  const btnCsv = $('#bulBtnCsv');
  if (btnCsv) {
    btnCsv.addEventListener('click', () => {
      if (!requirePriv('global:export')) return;
      const moisStr  = mois ? mois.value : '';
      const [debut, fin] = _parseMoisRange(moisStr);
      let totTransf = 0, totOuv = 0, totOps = 0, totBrut = 0, totPrimes = 0, totRet = 0, totNet = 0;
      const rows = DB.employes.map(emp => {
        const b = calculerBulletin(emp.id, debut, fin);
        if (!b) return null;
        totTransf += b.nbTransferts; totOuv += b.nbOuvertures; totOps += b.nbOps;
        totBrut += b.salaireBrut; totPrimes += b.primes; totRet += b.retenues; totNet += b.salaireNet;
        const roleLabel = emp.role === 'conducteur' ? 'Conducteur' :
                          emp.role === 'apprenti'   ? 'Apprenti'   : 'Autre';
        return [b.employe.nom, roleLabel, frDate(debut), frDate(fin),
                b.nbTransferts, b.nbOuvertures, b.nbOps,
                b.salaireBrut, b.primes, b.retenues, b.salaireNet];
      }).filter(Boolean);
      exportXLS(
        `bulletins_${(moisStr || 'periode').replace('-', '_')}.xls`,
        `Récapitulatif des Bulletins de Salaire (${moisStr || 'Période'})`,
        ['Employé', 'Rôle', 'Début', 'Fin', 'Transferts', 'Ouvertures', 'Nb ops',
         'Salaire brut', 'Primes', 'Retenues', 'Net à payer'],
        rows,
        { foot: [{ colspan: 4, text: 'Total (' + rows.length + ' employés)' }, totTransf, totOuv, totOps, totBrut, totPrimes, totRet, totNet] }
      );
    });
  }
}
