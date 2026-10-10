/* Mock PostgREST minimal pour tester la synchronisation Supabase en local.
   Endpoints utilisés par js/sync.js :
     GET  /rest/v1/data?select=...&updated_at=gt.<iso>&order=updated_at.asc&limit=N
     POST /rest/v1/data?on_conflict=collection,id   (upsert, Prefer: resolution=merge-duplicates)
   Usage : node tests/mock-postgrest.js [port]   (défaut 8765)
   État persisté dans tests/mock-postgrest-state.json
*/
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2]) || 8765;
const STATE = path.join(__dirname, 'mock-postgrest-state.json');

const rows = new Map(); // key = collection|id -> {collection,id,payload,updated_at}
try{
  JSON.parse(fs.readFileSync(STATE, 'utf8')).forEach(r => rows.set(r.collection + '|' + r.id, r));
}catch(e){}

function persist(){
  try{ fs.writeFileSync(STATE, JSON.stringify(Array.from(rows.values()), null, 1)); }catch(e){}
}

function cors(res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'apikey,authorization,content-type,prefer');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'content-range');
}

const server = http.createServer((req, res) => {
  cors(res);
  if(req.method === 'OPTIONS'){ res.writeHead(204); return res.end(); }

  const u = new URL(req.url, 'http://localhost');
  if(!u.pathname.startsWith('/rest/v1/data')){
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ message: 'not found: ' + u.pathname }));
  }

  if(req.method === 'GET'){
    const gt = u.searchParams.get('updated_at'); // format: gt.<iso>
    const limit = Number(u.searchParams.get('limit')) || 5000;
    let list = Array.from(rows.values());
    if(gt && gt.startsWith('gt.')){
      const since = gt.slice(3);
      list = list.filter(r => (r.updated_at || '') > since);
    }
    list.sort((a,b) => a.updated_at < b.updated_at ? -1 : 1);
    list = list.slice(0, limit);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(list));
  }

  if(req.method === 'POST'){
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let incoming;
      try{ incoming = JSON.parse(body); }catch(e){
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: 'invalid json' }));
      }
      if(!Array.isArray(incoming)) incoming = [incoming];
      let n = 0;
      incoming.forEach(r => {
        if(!r || !r.collection || !r.id || !r.payload) return;
        rows.set(r.collection + '|' + r.id, {
          collection: r.collection, id: r.id, payload: r.payload,
          updated_at: r.updated_at || new Date().toISOString()
        });
        n++;
      });
      persist();
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ n }));
    });
    return;
  }

  res.writeHead(405, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message: 'method not allowed' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('mock-postgrest listening on http://127.0.0.1:' + PORT);
});
