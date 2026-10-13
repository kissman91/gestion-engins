/* Vérification de l'interface : appareil vierge (récupération cloud), création des comptes,
   rôles restreints, comptes protégés, garde des routes.
   Dépendance facultative (non publiée) : npm i --no-save jsdom
   Exécution : NODE_PATH=<dossier jsdom> node tests/ui-utilisateurs.js                              */
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
window.fetch = async () => { throw new Error('hors ligne'); };

/* un seul eval : les let/const des scripts partagent le même scope */
const NL = String.fromCharCode(10);
const sources = ['js/store.js', 'js/charts.js', 'js/sync.js', 'js/app.js']
  .map(f => fs.readFileSync(path.join(root, f), 'utf8'))
  .join(NL + ';' + NL);
window.eval(sources + [
  '',
  ';window.APP = {',
  '  get DB(){ return DB; },',
  '  get formPrivs(){ return formPrivs; },',
  '  get formRole(){ return formRole; },',
  '  get usrSelection(){ return usrSelection; }',
  '};'
].join(NL));
window.eval('init()');

const $ = s => document.querySelector(s);
const vis = el => !!el && !el.classList.contains('hidden');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let echecs = 0;
const ok = (cond, label) => { if(cond) console.log('  OK  ' + label); else { echecs++; console.log('  ECHEC ' + label); } };
const setVal = (sel, v) => { $(sel).value = v; };
const submit = sel => $(sel).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
const change = sel => $(sel).dispatchEvent(new window.Event('change', { bubbles: true }));
const click = sel => $(sel).dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
const goto = v => { window.location.hash = '#/' + v; window.eval('route()'); };
const nbComptes = () => window.eval('utilisateurs().length');
const toast = () => $('#toast').textContent;

(async () => {
  console.log('');
  console.log('— Appareil vierge —');
  ok(vis($('#authScreen')), 'écran de démarrage affiché');
  ok(vis($('#cloudBootBox')), 'récupération des comptes proposée en priorité');
  ok(!vis($('#formFirstAdmin')), 'création d administrateur masquée par défaut');
  ok(!vis($('#formLogin')), 'formulaire de login masqué');

  setVal('#cbUrl', 'https://dummy.supabase.co'); setVal('#cbKey', 'cle-anon');
  window.fetch = async () => ({
    ok: true, headers: { get: () => 'application/json' },
    json: async () => [], text: async () => ''
  });
  submit('#formCloudBoot');
  await sleep(60);
  ok(vis($('#cbErr')), 'cloud vide → message d erreur');
  ok(window.APP.DB.settings.sbUrl === 'https://dummy.supabase.co', 'URL Supabase enregistrée localement');

  console.log('');
  console.log('— Création de l administrateur (poste du boss) —');
  click('#btnShowAdmin');
  ok(vis($('#formFirstAdmin')) && !vis($('#cloudBootBox')), 'bascule vers la création locale');
  setVal('#faNom', 'Kossi A.'); setVal('#faLogin', 'admin');
  setVal('#faMdp', 'secret123'); setVal('#faMdp2', 'secret123');
  submit('#formFirstAdmin');
  await sleep(80);
  ok(!vis($('#authScreen')), 'administrateur connecté');
  ok(vis($('#userChip')) && $('#ucNom').textContent.includes('Kossi'), 'compte affiché dans le menu');
  ok(nbComptes() === 1, 'un seul compte');

  console.log('');
  console.log('— L admin crée un gestionnaire —');
  goto('utilisateurs');
  click('#btnNewUser');
  setVal('#usrNom', 'Gérant'); setVal('#usrLogin', 'gerant');
  setVal('#usrMdp', 'gestion123'); setVal('#usrMdp2', 'gestion123');
  setVal('#usrRole', 'gestion'); change('#usrRole');
  submit('#formUser');
  await sleep(80);
  ok(nbComptes() === 2, 'gestionnaire créé');
  ok(window.APP.DB.utilisateurs[1].privileges.includes('utilisateurs:edit'), 'gestionnaire : droit sur les comptes');

  console.log('');
  console.log('— Le gestionnaire crée un conducteur, sans pouvoir s élever —');
  window.eval('doLogout()');
  await sleep(30);
  setVal('#lgLogin', 'gerant'); setVal('#lgMdp', 'gestion123');
  submit('#formLogin');
  await sleep(80);
  ok(!vis($('#authScreen')), 'gestionnaire connecté');
  ok(vis($('.nav a[data-view="utilisateurs"]')), 'menu Utilisateurs visible pour le gestionnaire');
  goto('utilisateurs');
  const opts = Array.from($('#usrRole').options);
  ok(opts.find(o => o.value === 'admin').disabled, 'rôle Administrateur grisé pour un gestionnaire');
  ok(opts.find(o => o.value === 'gestion').disabled, 'rôle Gestionnaire grisé pour un gestionnaire');
  ok(opts.find(o => o.value === 'saisie').disabled === false, 'rôle Conducteur disponible');

  const ligneAdmin = document.querySelector('#tableUsers tbody tr[data-user]');
  ok(ligneAdmin && !ligneAdmin.querySelector('button'), 'compte admin verrouillé pour le gestionnaire');

  click('#btnNewUser');
  setVal('#usrNom', 'Moussa D.'); setVal('#usrLogin', 'moussa');
  setVal('#usrMdp', 'terrain456'); setVal('#usrMdp2', 'terrain456');
  setVal('#usrRole', 'saisie'); change('#usrRole');
  submit('#formUser');
  await sleep(80);
  ok(nbComptes() === 3, 'gestionnaire : conducteur créé');

  click('#btnNewUser');
  setVal('#usrNom', 'Escroc'); setVal('#usrLogin', 'escroc');
  setVal('#usrMdp', 'escroc123'); setVal('#usrMdp2', 'escroc123');
  $('#usrRole').value = 'gestion'; change('#usrRole');
  submit('#formUser');
  await sleep(80);
  ok(nbComptes() === 3, 'gestionnaire : création d un gestionnaire refusée');
  ok(toast().includes('administrateur'), 'message explicite');

  console.log('');
  console.log('— Le conducteur : saisie seule —');
  window.eval('doLogout()');
  await sleep(30);
  setVal('#lgLogin', 'moussa'); setVal('#lgMdp', 'terrain456');
  submit('#formLogin');
  await sleep(80);
  ok(!vis($('#authScreen')), 'conducteur connecté');
  ok(!vis($('.nav a[data-view="parametres"]')), 'menu Paramètres masqué');
  ok(vis($('.nav a[data-view="terrain"]')), 'menu Saisie rapide visible');
  ok(!vis($('.nav a[data-view="utilisateurs"]')), 'menu Utilisateurs masqué');

  goto('parametres');
  ok(vis($('#view-acces-refuse')), 'accès refusé sur Paramètres');
  goto('terrain');
  ok(vis($('#view-terrain')), 'vue Saisie rapide affichée');
  window.eval("del('nimporte', 'charges')");
  await sleep(30);
  ok(toast().includes('Privilège'), 'suppression d une charge refusée');

  console.log('');
  console.log('— Retour administrateur —');
  window.eval('doLogout()');
  await sleep(30);
  setVal('#lgLogin', 'admin'); setVal('#lgMdp', 'secret123');
  submit('#formLogin');
  await sleep(80);
  goto('utilisateurs');
  ok(vis($('#view-utilisateurs')), 'l admin retrouve la vue Utilisateurs');
  ok(document.querySelectorAll('#tableUsers tbody tr[data-user]').length === 3, 'trois comptes listés');
  const ligneAdmin2 = document.querySelectorAll('#tableUsers tbody tr[data-user]')[0];
  ok(!!ligneAdmin2.querySelector('button'), 'l admin garde l accès aux boutons');

  console.log('');
  console.log(echecs === 0 ? 'RESULTAT : interface verifiee' : 'RESULTAT : ' + echecs + ' echec(s)');
  process.exit(echecs === 0 ? 0 : 1);
})().catch(e => { console.error('Erreur :', e); process.exit(1); });
