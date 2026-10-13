/* Vérification de l'interface : écran de connexion, garde des routes, matrice de privilèges.
   Dépendance facultative (non publiée) : npm i --no-save jsdom
   Exécution : node tests/ui-utilisateurs.js                                                    */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const dom = new JSDOM(html, { url: 'https://example.test/', pretendToBeVisual: true, runScripts: 'outside-only' });
const { window } = dom;
const document = window.document;

/* canvas neutre (les graphiques ne sont pas le sujet ici) */
window.HTMLCanvasElement.prototype.getContext = function(){
  const noop = () => {};
  return new Proxy({}, {
    get: (t, p) => (p === 'measureText' ? () => ({ width: 0 }) : (typeof p === 'string' ? noop : undefined)),
    set: () => true
  });
};
window.confirm = () => true;
window.prompt = () => null;
window.scrollTo = () => {};

/* un seul eval : les let/const des scripts partagent le même scope */
const sources = ['js/store.js', 'js/charts.js', 'js/sync.js', 'js/app.js']
  .map(f => fs.readFileSync(path.join(root, f), 'utf8'))
  .join('\n;\n');
window.eval(sources + `
;window.APP = {
  get DB(){ return DB; },
  get formPrivs(){ return formPrivs; },
  get formRole(){ return formRole; },
  get usrSelection(){ return usrSelection; }
};`);
window.eval('init()');

const $ = s => document.querySelector(s);
const vis = el => !!el && !el.classList.contains('hidden');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let echecs = 0;
const ok = (cond, label) => { if(cond) console.log('  ✓ ' + label); else { echecs++; console.log('  ✗ ' + label); } };
const setVal = (sel, v) => { $(sel).value = v; };
const submit = sel => $(sel).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
const change = sel => $(sel).dispatchEvent(new window.Event('change', { bubbles: true }));
const goto = v => { window.location.hash = '#/' + v; window.eval('route()'); };

(async () => {
  console.log('\n— Première ouverture —');
  ok(vis($('#authScreen')), 'écran de connexion affiché');
  ok(vis($('#formFirstAdmin')), 'création du 1er administrateur proposée');
  ok(!vis($('#formLogin')), 'formulaire de login masqué');
  ok(window.eval('utilisateurs().length') === 0, 'aucun compte au départ');
  ok(window.APP.DB.settings.nom === 'Mon Entreprise', 'état initial chargé');

  console.log('\n— Création de l’administrateur —');
  setVal('#faNom', 'Kossi A.'); setVal('#faLogin', 'admin');
  setVal('#faMdp', 'secret123'); setVal('#faMdp2', 'secret123');
  submit('#formFirstAdmin');
  await sleep(80);
  ok(!vis($('#authScreen')), 'écran de connexion masqué après création');
  ok(vis($('#userChip')), 'compte affiché dans le menu');
  ok($('#ucNom').textContent.includes('Kossi'), 'nom du compte affiché');
  ok(window.eval('currentUser().role') === 'admin', 'session administrateur ouverte');

  console.log('\n— Création d’un conducteur —');
  goto('utilisateurs');
  ok(vis($('#view-utilisateurs')), 'vue Utilisateurs affichée');
  ok(vis($('#btnNewUser')), 'bouton « nouvel utilisateur » visible pour l’admin');
  setVal('#usrNom', 'Moussa D.'); setVal('#usrLogin', 'moussa');
  setVal('#usrMdp', 'terrain456'); setVal('#usrMdp2', 'terrain456');
  setVal('#usrRole', 'saisie'); change('#usrRole');
  ok(window.APP.formPrivs.includes('terrain:edit') === true, 'rôle « saisie » présélectionne les droits terrain');
  submit('#formUser');
  await sleep(80);
  ok(window.eval('utilisateurs().length') === 2, 'deux comptes enregistrés');
  ok(document.querySelectorAll('#tableUsers tbody tr[data-user]').length === 2, 'liste des comptes à jour');
  ok(window.APP.DB.utilisateurs[1].privileges.includes('terrain:vue'), 'privilèges enregistrés sur le compte');

  console.log('\n— Matrice de privilèges —');
  ok(document.querySelector('#tablePrivs input[data-cle="terrain:vue"]').checked === true, 'case « Terrain / Voir » cochée pour le conducteur');
  ok(document.querySelector('#tablePrivs input[data-cle="charges:vue"]').checked === false, 'case « Charges / Voir » non cochée');
  ok(vis($('#tablePrivs tbody tr.priv-off')), 'module sans droit de vue grisé');
  const cbSuppr = document.querySelector('#tablePrivs input[data-cle="terrain:suppr"]');
  cbSuppr.checked = false;
  cbSuppr.dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(30);
  ok(window.APP.formPrivs.includes('terrain:suppr') === false, 'décocher une case retire le privilège');
  ok($('#usrRole').value === 'perso', 'le rôle bascule en « Personnalisé »');

  console.log('\n— Connexion du conducteur —');
  window.eval('doLogout()');
  await sleep(30);
  ok(vis($('#authScreen')), 'retour à l’écran de connexion');
  setVal('#lgLogin', 'moussa'); setVal('#lgMdp', 'terrain456');
  submit('#formLogin');
  await sleep(80);
  ok(!vis($('#authScreen')), 'conducteur connecté');
  ok(!vis($('.nav a[data-view="parametres"]')), 'menu « Paramètres » masqué');
  ok(vis($('.nav a[data-view="terrain"]')), 'menu « Saisie rapide » visible');
  ok(!vis($('.nav a[data-view="utilisateurs"]')), 'menu « Utilisateurs » masqué');
  ok(!vis($('#btnNewUser')), 'bouton « nouvel utilisateur » masqué');

  console.log('\n— Garde des routes —');
  goto('parametres');
  ok(vis($('#view-acces-refuse')), 'accès refusé sur Paramètres');
  ok(!vis($('#view-parametres')), 'vue Paramètres masquée');
  goto('terrain');
  ok(vis($('#view-terrain')), 'vue Saisie rapide affichée');
  goto('rapports');
  ok(vis($('#view-acces-refuse')), 'accès refusé sur Rapports');

  console.log('\n— Actions bloquées —');
  window.eval("del('nimporte', 'charges')");
  await sleep(30);
  ok($('#toast').textContent.includes('Privilège'), 'suppression d’une charge refusée');
  window.eval("resetMdpUser('x')");
  await sleep(30);
  ok($('#toast').textContent.includes('Privilège'), 'changement de mot de passe refusé');

  console.log('\n— Retour administrateur —');
  window.eval('doLogout()');
  await sleep(30);
  setVal('#lgLogin', 'admin'); setVal('#lgMdp', 'secret123');
  submit('#formLogin');
  await sleep(80);
  goto('utilisateurs');
  ok(vis($('#view-utilisateurs')), 'l’admin retrouve la vue Utilisateurs');
  ok(vis($('.nav a[data-view="parametres"]')), 'menu Paramètres de retour');

  console.log(echecs === 0 ? '\n✅ Interface vérifiée\n' : '\n❌ ' + echecs + ' échec(s)\n');
  process.exit(echecs === 0 ? 0 : 1);
})().catch(e => { console.error('❌ Erreur :', e); process.exit(1); });
