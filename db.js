// db.js - Base de datos SQLite usando sql.js (puro JavaScript, sin compilación)
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'taller.db');

let db = null;

function persistDb() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function makeStmt(sql) {
  return {
    run: (...params) => {
      const flat = params.flat();
      db.run(sql, flat);
      persistDb();
      return { changes: db.getRowsModified() };
    },
    get: (...params) => {
      const flat = params.flat();
      const stmt = db.prepare(sql);
      stmt.bind(flat);
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
      stmt.bind(flat);
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    }
  };
}

function getDb() {
  if (!db) throw new Error('DB no inicializada');
  return {
    prepare: (sql) => makeStmt(sql),
    exec: (sql) => { db.run(sql); persistDb(); },
    pragma: () => {},
    run: (sql, ...p) => { db.run(sql, p.flat()); persistDb(); }
  };
}

async function initDb() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

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

    CREATE TABLE IF NOT EXISTS precios_service (
      id TEXT PRIMARY KEY,
      tipo TEXT NOT NULL UNIQUE,
      nombre TEXT NOT NULL,
      precio REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT OR IGNORE INTO precios_service (id, tipo, nombre, precio) VALUES
      ('1', 'basico', 'Mantenimiento Básico', 15000),
      ('2', 'intermedio', 'Mantenimiento Intermedio', 25000),
      ('3', 'mayor', 'Mantenimiento Mayor', 40000);
  `);

  // Migraciones — agregar columnas nuevas si no existen
  try { db.run('ALTER TABLE turnos ADD COLUMN wa_cliente TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE diagnosticos ADD COLUMN wa_cliente TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE reparaciones ADD COLUMN wa_cliente TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE presupuestos ADD COLUMN wa_cliente TEXT'); } catch(e) {}

  persistDb();
  console.log('✅ Base de datos inicializada en', DB_PATH);
}

module.exports = { getDb, initDb };
