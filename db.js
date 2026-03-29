// db.js - sql.js database with atomic writes and corruption recovery
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'taller.db');
const DB_TEMP = path.join(__dirname, 'taller.db.tmp');

let db = null;
let writing = false;
let pendingWrite = false;

function persistDb() {
  if (writing) { pendingWrite = true; return; }
  try {
    writing = true;
    const data = db.export();
    fs.writeFileSync(DB_TEMP, Buffer.from(data));
    fs.renameSync(DB_TEMP, DB_PATH);
  } catch(e) {
    console.error('❌ [DB] persist error:', e.message);
  } finally {
    writing = false;
    if (pendingWrite) { pendingWrite = false; setImmediate(persistDb); }
  }
}

function makeStmt(sql) {
  return {
    run: (...params) => {
      const flat = params.flat();
      db.run(sql, flat.length ? flat : undefined);
      persistDb();
      return { changes: db.getRowsModified() };
    },
    get: (...params) => {
      const flat = params.flat();
      const stmt = db.prepare(sql);
      if (flat.length) stmt.bind(flat);
      if (stmt.step()) {
        const row = stmt.getAsObject();
        stmt.free();
        return row;
      }
      stmt.free();
      return undefined;
    },
    all: (...params) => {
      const flat = params.flat();
      const stmt = db.prepare(sql);
      const rows = [];
      if (flat.length) stmt.bind(flat);
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    }
  };
}

function getDb() {
  if (!db) throw new Error('DB not initialized');
  return {
    prepare: (sql) => makeStmt(sql),
    exec: (sql) => { db.run(sql); persistDb(); },
    pragma: () => {},
    run: (sql, ...p) => { db.run(sql, p.flat().length ? p.flat() : undefined); persistDb(); }
  };
}

// Insert a row using prepare/bind/step — most reliable with sql.js
function dbInsert(sql, params) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  stmt.step();
  stmt.free();
}

// Helper: run a SELECT with the native sql.js db object and return all rows as objects
function sqlAll(sql, params) {
  const stmt = db.prepare(sql);
  const rows = [];
  if (params && params.length) stmt.bind(params);
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

async function initDb() {
  const SQL = await initSqlJs();

  // Load or create DB
  if (fs.existsSync(DB_PATH)) {
    try {
      const buf = fs.readFileSync(DB_PATH);
      db = new SQL.Database(buf);
      db.run('SELECT 1'); // integrity check
      console.log('✅ [DB] Loaded from disk');
    } catch(e) {
      console.error('❌ [DB] Corrupted, attempting recovery...');
      db = await recoverFromBackup(SQL);
    }
  } else {
    db = new SQL.Database();
    console.log('📦 [DB] New database created');
  }

  // ── SCHEMA ────────────────────────────────────────────────────────────────
  db.run(`
    CREATE TABLE IF NOT EXISTS turnos (
      id TEXT PRIMARY KEY,
      nombre TEXT NOT NULL,
      telefono TEXT NOT NULL,
      marca_moto TEXT NOT NULL,
      modelo_moto TEXT NOT NULL,
      patente TEXT NOT NULL,
      tipo_servicio TEXT NOT NULL,
      descripcion TEXT,
      fecha TEXT NOT NULL,
      hora_inicio TEXT NOT NULL,
      hora_fin TEXT NOT NULL,
      estado TEXT NOT NULL DEFAULT 'pendiente',
      wa_cliente TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS diagnosticos (
      id TEXT PRIMARY KEY,
      turno_id TEXT NOT NULL,
      estado TEXT NOT NULL DEFAULT 'pendiente',
      notas TEXT,
      wa_cliente TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS presupuestos (
      id TEXT PRIMARY KEY,
      diagnostico_id TEXT NOT NULL,
      descripcion_trabajo TEXT NOT NULL,
      materiales TEXT,
      precio_total REAL NOT NULL,
      tiempo_estimado_dias INTEGER NOT NULL DEFAULT 1,
      estado TEXT NOT NULL DEFAULT 'pendiente',
      link_token TEXT UNIQUE NOT NULL,
      wa_cliente TEXT,
      respondido_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS reparaciones (
      id TEXT PRIMARY KEY,
      presupuesto_id TEXT NOT NULL,
      estado TEXT NOT NULL DEFAULT 'aprobado',
      notas TEXT,
      fecha_estimada_fin TEXT,
      wa_cliente TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // ── SAFE COLUMN MIGRATIONS ────────────────────────────────────────────────
  ['ALTER TABLE turnos ADD COLUMN wa_cliente TEXT',
   'ALTER TABLE diagnosticos ADD COLUMN wa_cliente TEXT',
   'ALTER TABLE reparaciones ADD COLUMN wa_cliente TEXT',
   'ALTER TABLE presupuestos ADD COLUMN wa_cliente TEXT',
  ].forEach(sql => { try { db.run(sql); } catch(e) {} });

  // ── PRECIOS SERVICE — recreate with correct schema if needed ───────────────
  initPreciosService();

  persistDb();
  console.log('✅ [DB] Ready:', DB_PATH);
}

function initPreciosService() {
  try {
    // Check if precios_service exists and has correct schema
    const tables = sqlAll("SELECT name FROM sqlite_master WHERE type='table' AND name='precios_service'");

    if (tables.length > 0) {
      const cols = sqlAll('PRAGMA table_info(precios_service)');
      const hasCilindrada = cols.some(c => c.name === 'cilindrada');

      if (!hasCilindrada) {
        console.log('[DB] Migrating precios_service to new schema...');
        db.run('DROP TABLE precios_service');
      } else {
        // Correct schema — just ensure all 9 rows exist
        const countRows = sqlAll('SELECT COUNT(*) as c FROM precios_service');
        const row = countRows[0] || { c: 0 };
        if (row.c >= 9) {
          console.log('[DB] precios_service OK (' + row.c + ' rows)');
          return;
        }
        console.log('[DB] precios_service has only ' + row.c + ' rows, seeding...');
      }
    }

    // Create table with correct schema
    db.run(`CREATE TABLE IF NOT EXISTS precios_service (
      id TEXT PRIMARY KEY,
      cilindrada TEXT NOT NULL,
      mantenimiento TEXT NOT NULL,
      nombre_cilindrada TEXT NOT NULL,
      nombre_mantenimiento TEXT NOT NULL,
      precio REAL NOT NULL DEFAULT 0,
      detalles TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(cilindrada, mantenimiento)
    )`);

    const ins = 'INSERT OR IGNORE INTO precios_service (id,cilindrada,mantenimiento,nombre_cilindrada,nombre_mantenimiento,precio,detalles) VALUES (?,?,?,?,?,?,?)';
    const seed = [
      ['1','baja','basico',   'Baja cilindrada (hasta 250cc)',   'Mantenimiento Básico',     12000, 'Cambio de aceite y filtro|Revisión de frenos y pastillas|Ajuste de cadena y lubricación|Revisión de neumáticos|Chequeo de luces y batería'],
      ['2','baja','intermedio','Baja cilindrada (hasta 250cc)',  'Mantenimiento Intermedio', 18000, 'Todo lo del básico|Cambio de filtro de aire|Revisión de bujías|Inspección del sistema eléctrico|Lubricación de cables'],
      ['3','baja','mayor',    'Baja cilindrada (hasta 250cc)',   'Mantenimiento Mayor',      28000, 'Todo lo del intermedio|Cambio de líquido de frenos|Revisión de amortiguadores|Chequeo de transmisión|Diagnóstico ECU'],
      ['4','media','basico',  'Media cilindrada (251cc-600cc)',  'Mantenimiento Básico',     18000, 'Cambio de aceite y filtro|Revisión de frenos y pastillas|Ajuste de cadena y lubricación|Revisión de neumáticos|Chequeo de luces y batería'],
      ['5','media','intermedio','Media cilindrada (251cc-600cc)','Mantenimiento Intermedio', 28000, 'Todo lo del básico|Cambio de filtro de aire|Revisión de bujías|Inspección del sistema eléctrico|Lubricación de cables'],
      ['6','media','mayor',   'Media cilindrada (251cc-600cc)',  'Mantenimiento Mayor',      42000, 'Todo lo del intermedio|Cambio de líquido de frenos|Revisión de amortiguadores|Chequeo de transmisión|Diagnóstico ECU'],
      ['7','alta','basico',   'Alta cilindrada (mas de 600cc)',  'Mantenimiento Básico',     25000, 'Cambio de aceite premium y filtro|Revisión de frenos y pastillas|Ajuste de cadena|Revisión de neumáticos|Chequeo de luces y batería'],
      ['8','alta','intermedio','Alta cilindrada (mas de 600cc)', 'Mantenimiento Intermedio', 38000, 'Todo lo del básico|Cambio de filtro de aire|Revisión de bujías|Inspección del sistema eléctrico|Lubricación de cables'],
      ['9','alta','mayor',    'Alta cilindrada (mas de 600cc)',  'Mantenimiento Mayor',      58000, 'Todo lo del intermedio|Cambio de líquido de frenos|Revisión de amortiguadores|Chequeo de transmisión|Diagnóstico ECU completo'],
    ];
    seed.forEach(row => dbInsert(ins, row));
    console.log('[DB] precios_service seeded with 9 rows');
  } catch(e) {
    console.error('[DB] precios_service init error:', e.message);
  }
}

async function recoverFromBackup(SQL) {
  const backupDir = path.join(__dirname, 'backups');
  if (!fs.existsSync(backupDir)) return new SQL.Database();
  const files = fs.readdirSync(backupDir).filter(f => f.startsWith('taller-backup-')).sort().reverse();
  for (const f of files) {
    try {
      const buf = fs.readFileSync(path.join(backupDir, f));
      const d = new SQL.Database(buf);
      d.run('SELECT 1');
      console.log('✅ [DB] Recovered from backup:', f);
      return d;
    } catch(e) {}
  }
  return new SQL.Database();
}

module.exports = { getDb, initDb, persistDb };
