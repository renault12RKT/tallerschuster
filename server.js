// server.js - Taller Schuster v3
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const { getDb, initDb, persistDb } = require('./db');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const MECANICO_TEL = '3735582128';

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function waLink(telefono, mensaje) {
  const tel = telefono.replace(/\D/g, '');
  const num = tel.startsWith('54') ? tel : `54${tel}`;
  return `https://wa.me/${num}?text=${encodeURIComponent(mensaje)}`;
}
function waMecanico(msg) { return waLink(MECANICO_TEL, msg); }

function waPorEstado(estado, datos) {
  const { nombre, telefono, marca_moto, modelo_moto, patente, fecha, hora_inicio, tipo_servicio } = datos;
  const moto = `${marca_moto} ${modelo_moto} (${patente})`;
  const msgs = {
    confirmado:     `✅ *Turno confirmado — Taller Schuster*\n\nHola ${nombre}, tu turno fue confirmado.\n\n📅 ${fecha} a las ${hora_inicio} hs\n🏍️ ${moto}\n\nPodés traer la moto. ¡Te esperamos!`,
    completado:     `✅ *Taller Schuster*\n\nHola ${nombre}, el ${tipo_servicio === 'service' ? 'servicio' : 'diagnóstico'} de tu ${moto} fue completado.\n\nPodés pasar a retirar la moto cuando quieras. ¡Gracias!`,
    cancelado:      `❌ *Taller Schuster*\n\nHola ${nombre}, tu turno para la ${moto} fue cancelado.\n\nPodés reprogramar cuando quieras. 👍`,
    finalizado:     `✅ *Taller Schuster*\n\nHola ${nombre}, tu ${moto} ya está lista para retirar.\n\nPasá por el taller cuando quieras. ¡Gracias por confiar en nosotros! 🔧`,
    en_reparacion:  `🔧 *Taller Schuster*\n\nHola ${nombre}, tu ${moto} ya está en reparación.\n\nTe avisamos cuando esté lista. 👍`,
    sin_reparacion: `🔍 *Taller Schuster*\n\nHola ${nombre}, el diagnóstico de tu ${moto} fue completado.\n\n_No se requiere reparación por el momento._\n\nPasá cuando quieras a retirar la moto y te contamos los detalles. ¡Gracias!`,
  };
  const msg = msgs[estado];
  return msg ? waLink(telefono, msg) : null;
}

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '100kb' }));

// ─── DISPONIBILIDAD ───────────────────────────────────────────────────────────
app.get('/api/disponibilidad', (req, res) => {
  const { fecha, tipo } = req.query;
  if (!fecha || !tipo) return res.status(400).json({ error: 'Falta fecha o tipo' });

  const hoy = new Date(); hoy.setHours(0,0,0,0);
  const fechaSel = new Date(fecha + 'T00:00:00');
  if ((fechaSel - hoy) / 86400000 < 1)
    return res.json({ disponibles: [], mensaje: 'Reservas con al menos 1 día de anticipación' });
  if (fechaSel.getDay() === 0)
    return res.json({ disponibles: [], mensaje: 'No atendemos los domingos' });

  const db = getDb();
  const turnos = db.prepare(`SELECT hora_inicio, hora_fin FROM turnos WHERE fecha = ? AND estado NOT IN ('cancelado','no_presentado')`).all(fecha);

  const horasOcupadas = new Set();
  turnos.forEach(t => {
    for (let h = parseInt(t.hora_inicio.split(':')[0]); h < parseInt(t.hora_fin.split(':')[0]); h++) {
      horasOcupadas.add(`${String(h).padStart(2,'0')}:00`);
    }
  });

  const duracion = tipo === 'service' ? 2 : 1;
  const bloques = generarBloques();
  const disponibles = bloques.filter(b => {
    const hora = parseInt(b.split(':')[0]);
    for (let d = 0; d < duracion; d++) {
      if (horasOcupadas.has(`${String(hora+d).padStart(2,'0')}:00`)) return false;
      if (!esDentroDeHorario(b, duracion)) return false;
    }
    return true;
  });

  res.json({ disponibles });
});

// ─── CREAR TURNO ──────────────────────────────────────────────────────────────
app.post('/api/turnos', (req, res) => {
  const { nombre, telefono, marca_moto, modelo_moto, patente, tipo_servicio, tipo_service, descripcion, fecha, hora_inicio } = req.body;

  if (!nombre || !telefono || !marca_moto || !modelo_moto || !patente || !tipo_servicio || !fecha || !hora_inicio)
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  if (tipo_servicio === 'diagnostico' && !descripcion)
    return res.status(400).json({ error: 'La descripción es obligatoria para diagnóstico' });
  if (nombre.trim().length > 100) return res.status(400).json({ error: 'Nombre demasiado largo' });
  if (descripcion && descripcion.length > 500) return res.status(400).json({ error: 'Descripción demasiado larga' });

  const hoyCheck = new Date(); hoyCheck.setHours(0,0,0,0);
  if ((new Date(fecha + 'T00:00:00') - hoyCheck) / 86400000 < 1)
    return res.status(400).json({ error: 'Reservas con al menos 1 día de anticipación' });
  if (new Date(fecha + 'T00:00:00').getDay() === 0)
    return res.status(400).json({ error: 'No atendemos los domingos' });

  const db = getDb();
  const duracion = tipo_servicio === 'service' ? 2 : 1;
  const [h] = hora_inicio.split(':').map(Number);
  const hora_fin = `${String(h + duracion).padStart(2,'0')}:00`;

  const conflicto = db.prepare(`
    SELECT id FROM turnos WHERE fecha = ? AND estado NOT IN ('cancelado','no_presentado')
    AND NOT (hora_fin <= ? OR hora_inicio >= ?)
  `).get(fecha, hora_inicio, hora_fin);
  if (conflicto) return res.status(409).json({ error: 'El horario ya está ocupado' });

  const id = uuidv4();
  const descFinal = tipo_service ? `[${tipo_service}] ${descripcion || ''}`.trim() : (descripcion || null);

  db.prepare(`
    INSERT INTO turnos (id, nombre, telefono, marca_moto, modelo_moto, patente, tipo_servicio, descripcion, fecha, hora_inicio, hora_fin, estado)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente')
  `).run(id, nombre.trim(), telefono.trim(), marca_moto.trim(), modelo_moto.trim(), patente.trim().toUpperCase(), tipo_servicio, descFinal, fecha, hora_inicio, hora_fin);

  if (tipo_servicio === 'diagnostico') {
    db.prepare('INSERT INTO diagnosticos (id, turno_id) VALUES (?, ?)').run(uuidv4(), id);
  }

  const turno = db.prepare('SELECT * FROM turnos WHERE id = ?').get(id);
  const tipoLabel = tipo_servicio === 'service' ? 'Servicio' : 'Diagnóstico';
  const msgMec = `🔧 *Nuevo turno*\n\n👤 ${nombre}\n📱 ${telefono}\n🏍️ ${marca_moto} ${modelo_moto} · ${patente}\n📋 ${tipoLabel}\n📅 ${fecha} ${hora_inicio} hs${descripcion ? '\n💬 ' + descripcion : ''}`;

  res.status(201).json({ turno, wa_mecanico: waMecanico(msgMec) });
});

// ─── ADMIN - TURNOS ───────────────────────────────────────────────────────────
app.get('/api/admin/turnos', (req, res) => {
  const db = getDb();
  const { fecha, busqueda } = req.query;
  let query = "SELECT * FROM turnos WHERE estado != 'cancelado'";
  const params = [];
  if (fecha) { query += ' AND fecha = ?'; params.push(fecha); }
  if (busqueda) {
    query += ' AND (UPPER(nombre) LIKE ? OR UPPER(patente) LIKE ?)';
    const b = `%${busqueda.toUpperCase()}%`;
    params.push(b, b);
  }
  query += ' ORDER BY fecha ASC, hora_inicio ASC';
  res.json(db.prepare(query).all(...params));
});

app.patch('/api/admin/turnos/:id', (req, res) => {
  const db = getDb();
  const { estado } = req.body;
  const validos = ['pendiente','confirmado','cancelado','completado','no_presentado'];
  if (!validos.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });

  const turno = db.prepare('SELECT * FROM turnos WHERE id = ?').get(req.params.id);
  if (!turno) return res.status(404).json({ error: 'No encontrado' });

  const wa_cliente = waPorEstado(estado, turno) || turno.wa_cliente || null;
  db.prepare('UPDATE turnos SET estado = ?, wa_cliente = ? WHERE id = ?').run(estado, wa_cliente, req.params.id);
  res.json({ ok: true, wa_cliente });
});

app.delete('/api/admin/turnos/:id', (req, res) => {
  const db = getDb();
  const turno = db.prepare('SELECT * FROM turnos WHERE id = ?').get(req.params.id);
  if (!turno) return res.status(404).json({ error: 'No encontrado' });
  const wa = waPorEstado('cancelado', turno);
  db.prepare("UPDATE turnos SET estado = 'cancelado', wa_cliente = ? WHERE id = ?").run(wa, req.params.id);
  res.json({ ok: true, wa_cliente: wa });
});

// ─── CONSULTA PÚBLICA ─────────────────────────────────────────────────────────
app.get('/api/motos/estado', (req, res) => {
  const { patente } = req.query;
  if (!patente) return res.status(400).json({ error: 'Falta patente' });

  const db = getDb();
  const pat = patente.toUpperCase().replace(/[\s\-]/g, '');

  const turno = db.prepare(`
    SELECT t.*, d.estado as diag_estado, r.estado as rep_estado,
           r.updated_at as rep_updated, d.updated_at as diag_updated
    FROM turnos t
    LEFT JOIN diagnosticos d ON d.turno_id = t.id
    LEFT JOIN presupuestos p ON p.diagnostico_id = d.id
    LEFT JOIN reparaciones r ON r.presupuesto_id = p.id
    WHERE UPPER(REPLACE(REPLACE(t.patente,' ',''),'-','')) = ?
    AND t.estado NOT IN ('cancelado')
    ORDER BY t.created_at DESC
    LIMIT 1
  `).get(pat);

  if (!turno) return res.status(404).json({ error: 'No se encontró moto activa con esa patente' });

  let estadoActual = turno.estado;
  let ultimaActualizacion = turno.created_at;

  if (turno.rep_estado) {
    const mapaRep = { aprobado: 'en_reparacion', en_reparacion: 'en_reparacion', finalizado: 'finalizado', entregado: 'entregado' };
    estadoActual = mapaRep[turno.rep_estado] || turno.rep_estado;
    ultimaActualizacion = turno.rep_updated || ultimaActualizacion;
  } else if (turno.diag_estado) {
    const mapaDiag = { pendiente: 'en_revision', en_revision: 'en_revision', presupuesto_generado: 'esperando_aprobacion', completado: 'completado', sin_reparacion: 'sin_reparacion' };
    estadoActual = mapaDiag[turno.diag_estado] || turno.diag_estado;
    ultimaActualizacion = turno.diag_updated || ultimaActualizacion;
  }

  const msgConsulta = `Hola, consulto por mi moto patente ${turno.patente}`;
  const wa_consulta = waMecanico(msgConsulta);

  res.json({
    patente: turno.patente,
    moto: `${turno.marca_moto} ${turno.modelo_moto}`,
    estado: estadoActual,
    ultima_actualizacion: ultimaActualizacion,
    wa_consulta,
  });
});

// ─── NOTIFICACIÓN MANUAL ──────────────────────────────────────────────────────
app.post('/api/admin/turnos/:id/notificar', (req, res) => {
  const db = getDb();
  const { mensaje_custom } = req.body;
  const turno = db.prepare('SELECT * FROM turnos WHERE id = ?').get(req.params.id);
  if (!turno) return res.status(404).json({ error: 'No encontrado' });

  let wa_cliente;
  if (mensaje_custom) {
    wa_cliente = waLink(turno.telefono, mensaje_custom);
  } else {
    wa_cliente = waPorEstado(turno.estado, turno) || turno.wa_cliente;
  }

  if (!wa_cliente) return res.status(400).json({ error: 'No hay mensaje para enviar' });
  res.json({ ok: true, wa_cliente });
});

// ─── ADMIN - CONTEO ───────────────────────────────────────────────────────────
app.get('/api/admin/turnos-count', (req, res) => {
  const db = getDb();
  const r = db.prepare(`SELECT COUNT(*) as c FROM turnos WHERE estado IN ('pendiente','confirmado')`).get();
  res.json({ count: r.c });
});

// ─── ADMIN - ACTIVOS ──────────────────────────────────────────────────────────
app.get('/api/admin/services-activos', (req, res) => {
  const db = getDb();
  const hoy = new Date().toISOString().split('T')[0];
  res.json(db.prepare(`SELECT * FROM turnos WHERE estado = 'confirmado' AND fecha >= ? ORDER BY fecha ASC, hora_inicio ASC`).all(hoy));
});

// ─── ADMIN - DIAGNÓSTICOS ─────────────────────────────────────────────────────
app.get('/api/admin/diagnosticos', (req, res) => {
  const db = getDb();
  res.json(db.prepare(`
    SELECT d.*, t.nombre, t.telefono, t.marca_moto, t.modelo_moto, t.patente, t.descripcion, t.fecha, t.hora_inicio
    FROM diagnosticos d JOIN turnos t ON d.turno_id = t.id
    WHERE d.estado NOT IN ('completado','sin_reparacion')
    ORDER BY t.fecha DESC
  `).all());
});

app.patch('/api/admin/diagnosticos/:id', (req, res) => {
  const db = getDb();
  const { estado, notas } = req.body;
  const validos = ['pendiente','en_revision','presupuesto_generado','completado','sin_reparacion'];
  if (!validos.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
  if (notas && notas.length > 1000) return res.status(400).json({ error: 'Notas demasiado largas' });

  const diag = db.prepare(`SELECT d.*, t.nombre, t.telefono, t.marca_moto, t.modelo_moto, t.patente FROM diagnosticos d JOIN turnos t ON d.turno_id = t.id WHERE d.id = ?`).get(req.params.id);
  if (!diag) return res.status(404).json({ error: 'No encontrado' });

  const wa_cliente = waPorEstado(estado, { ...diag, tipo_servicio: 'diagnostico' }) || diag.wa_cliente || null;
  db.prepare(`UPDATE diagnosticos SET estado = ?, notas = ?, wa_cliente = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(estado, notas || null, wa_cliente, req.params.id);
  res.json({ ok: true, wa_cliente });
});

// ─── ADMIN - PRESUPUESTOS ─────────────────────────────────────────────────────
app.post('/api/admin/presupuestos', (req, res) => {
  const { diagnostico_id, descripcion_trabajo, materiales, precio_total, tiempo_estimado_dias } = req.body;
  if (!diagnostico_id || !descripcion_trabajo || !precio_total) return res.status(400).json({ error: 'Faltan campos' });
  if (descripcion_trabajo.length > 1000) return res.status(400).json({ error: 'Descripción demasiado larga' });

  const db = getDb();
  const id = uuidv4();
  const token = uuidv4().replace(/-/g,'').substring(0,16);

  db.prepare(`INSERT INTO presupuestos (id, diagnostico_id, descripcion_trabajo, materiales, precio_total, tiempo_estimado_dias, link_token) VALUES (?,?,?,?,?,?,?)`)
    .run(id, diagnostico_id, descripcion_trabajo, materiales||null, precio_total, tiempo_estimado_dias||1, token);
  db.prepare(`UPDATE diagnosticos SET estado='presupuesto_generado', updated_at=datetime('now') WHERE id=?`).run(diagnostico_id);

  const info = db.prepare(`SELECT t.nombre,t.telefono,t.marca_moto,t.modelo_moto,t.patente FROM diagnosticos d JOIN turnos t ON d.turno_id=t.id WHERE d.id=?`).get(diagnostico_id);
  let msg = `🔧 *Presupuesto - Taller Schuster*\n\nHola ${info.nombre}, presupuesto para tu ${info.marca_moto} ${info.modelo_moto} (${info.patente}).\n\n📋 *Trabajo:* ${descripcion_trabajo}`;
  if (materiales) msg += `\n🔩 *Materiales a traer:* ${materiales}`;
  msg += `\n💰 *Total (mano de obra): $${Number(precio_total).toLocaleString()}*`;
  msg += `\n⏱️ *Tiempo estimado:* ${tiempo_estimado_dias} día${tiempo_estimado_dias > 1 ? 's' : ''}`;
  msg += `\n\n¿Aprobás? Respondé *SI* o *NO*.\n\n_Taller Schuster_`;

  const wa_cliente = waLink(info.telefono, msg);
  db.prepare('UPDATE presupuestos SET wa_cliente=? WHERE id=?').run(wa_cliente, id);
  const presupuesto = db.prepare('SELECT * FROM presupuestos WHERE id=?').get(id);
  res.status(201).json({ presupuesto, link_token: token, wa_cliente });
});

app.get('/api/admin/presupuestos', (req, res) => {
  const db = getDb();
  res.json(db.prepare(`
    SELECT p.*, d.notas as diag_notas, t.nombre, t.telefono, t.marca_moto, t.modelo_moto, t.patente
    FROM presupuestos p JOIN diagnosticos d ON p.diagnostico_id=d.id JOIN turnos t ON d.turno_id=t.id
    ORDER BY p.created_at DESC
  `).all());
});

app.patch('/api/admin/presupuestos/:id/responder', (req, res) => {
  const { decision } = req.body;
  if (!['aceptado','rechazado'].includes(decision)) return res.status(400).json({ error: 'Inválido' });

  const db = getDb();
  const pres = db.prepare('SELECT * FROM presupuestos WHERE id=?').get(req.params.id);
  if (!pres) return res.status(404).json({ error: 'No encontrado' });

  db.prepare(`UPDATE presupuestos SET estado=?, respondido_at=datetime('now') WHERE id=?`).run(decision, req.params.id);

  if (decision === 'aceptado') {
    const activas = db.prepare(`SELECT COUNT(*) as c FROM reparaciones WHERE estado IN ('aprobado','en_reparacion')`).get();
    if (activas.c >= 3) return res.status(409).json({ error: 'Taller lleno (3/3)' });
    db.prepare(`INSERT INTO reparaciones (id, presupuesto_id, estado) VALUES (?,?,'aprobado')`).run(uuidv4(), pres.id);
  }
  res.json({ ok: true });
});

app.get('/api/presupuesto/:token', (req, res) => {
  const db = getDb();
  const pres = db.prepare(`SELECT p.*,t.nombre,t.marca_moto,t.modelo_moto,t.patente FROM presupuestos p JOIN diagnosticos d ON p.diagnostico_id=d.id JOIN turnos t ON d.turno_id=t.id WHERE p.link_token=?`).get(req.params.token);
  if (!pres) return res.status(404).json({ error: 'No encontrado' });
  res.json(pres);
});

// ─── ADMIN - REPARACIONES ─────────────────────────────────────────────────────
app.get('/api/admin/reparaciones', (req, res) => {
  const db = getDb();
  res.json(db.prepare(`
    SELECT r.*, p.descripcion_trabajo, p.precio_total, p.tiempo_estimado_dias,
           t.nombre, t.telefono, t.marca_moto, t.modelo_moto, t.patente
    FROM reparaciones r JOIN presupuestos p ON r.presupuesto_id=p.id
    JOIN diagnosticos d ON p.diagnostico_id=d.id JOIN turnos t ON d.turno_id=t.id
    ORDER BY r.created_at DESC
  `).all());
});

app.patch('/api/admin/reparaciones/:id', (req, res) => {
  const db = getDb();
  const { estado, notas, fecha_estimada_fin } = req.body;
  const validos = ['aprobado','en_reparacion','finalizado','entregado'];
  if (!validos.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
  if (notas && notas.length > 1000) return res.status(400).json({ error: 'Notas demasiado largas' });

  const rep = db.prepare(`
    SELECT r.*, t.nombre, t.telefono, t.marca_moto, t.modelo_moto, t.patente, p.precio_total
    FROM reparaciones r JOIN presupuestos p ON r.presupuesto_id=p.id
    JOIN diagnosticos d ON p.diagnostico_id=d.id JOIN turnos t ON d.turno_id=t.id
    WHERE r.id=?
  `).get(req.params.id);
  if (!rep) return res.status(404).json({ error: 'No encontrado' });

  const wa_cliente = waPorEstado(estado, rep) || rep.wa_cliente || null;
  db.prepare(`UPDATE reparaciones SET estado=?, notas=?, fecha_estimada_fin=?, wa_cliente=?, updated_at=datetime('now') WHERE id=?`)
    .run(estado, notas||null, fecha_estimada_fin||null, wa_cliente, req.params.id);
  res.json({ ok: true, wa_cliente });
});

// ─── EXPORTAR HISTORIAL — TXT descargable (debe ir ANTES de /:patente) ────────
app.get('/api/admin/historial/exportar/:patente', (req, res) => {
  const db = getDb();
  const patente = req.params.patente.toUpperCase().replace(/[\s\-]/g,'');

  const rows = db.prepare(`
    SELECT t.fecha, t.hora_inicio, t.nombre, t.telefono, t.marca_moto, t.modelo_moto, t.patente,
           t.tipo_servicio, t.estado as turno_estado, t.descripcion,
           d.estado as diag_estado, d.notas as diag_notas,
           p.descripcion_trabajo, p.precio_total, p.materiales,
           r.estado as rep_estado, r.notas as rep_notas
    FROM turnos t
    LEFT JOIN diagnosticos d ON d.turno_id=t.id
    LEFT JOIN presupuestos p ON p.diagnostico_id=d.id
    LEFT JOIN reparaciones r ON r.presupuesto_id=p.id
    WHERE UPPER(REPLACE(REPLACE(t.patente,' ',''),'-','')) = ?
    ORDER BY t.fecha DESC
  `).all(patente);

  if (rows.length === 0) return res.status(404).json({ error: 'Sin historial para esa patente' });

  const marca   = rows[0].marca_moto || '';
  const modelo  = rows[0].modelo_moto || '';
  const sep     = '═'.repeat(52);
  const sepThin = '─'.repeat(52);
  const now     = new Date();
  const fechaGen = now.toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric' });
  const horaGen  = now.toLocaleTimeString('es-AR', { hour:'2-digit', minute:'2-digit' });

  const TIPO_LABEL = { service: 'Service / Mantenimiento', diagnostico: 'Diagnóstico' };
  const ESTADO_LABEL = {
    pendiente:'Pendiente', confirmado:'Confirmado', cancelado:'Cancelado',
    completado:'Completado', en_revision:'En revisión', presupuesto_generado:'Con presupuesto',
    aprobado:'Aprobado', en_reparacion:'En reparación', finalizado:'Finalizado',
    entregado:'Entregado', sin_reparacion:'Sin reparación', no_presentado:'No se presentó'
  };

  let txt = '';
  txt += `╔${sep}╗\n`;
  txt += `║  HISTORIAL DE SERVICIO — TALLER SCHUSTER                ║\n`;
  txt += `╚${sep}╝\n\n`;
  txt += `  Vehículo  : ${marca} ${modelo}\n`;
  txt += `  Patente   : ${rows[0].patente}\n`;
  txt += `  Cliente   : ${rows[0].nombre}\n`;
  txt += `  Teléfono  : ${rows[0].telefono}\n`;
  txt += `  Generado  : ${fechaGen} a las ${horaGen} hs\n`;
  txt += `  Registros : ${rows.length}\n`;
  txt += `\n${sepThin}\n\n`;

  let totalGastado = 0;
  rows.forEach(r => { if (r.precio_total) totalGastado += Number(r.precio_total); });

  rows.forEach((r, i) => {
    const num = String(i + 1).padStart(2, '0');
    txt += `  [${num}] ${r.fecha}  —  ${r.hora_inicio} hs\n`;
    txt += `      Tipo     : ${TIPO_LABEL[r.tipo_servicio] || r.tipo_servicio}\n`;
    txt += `      Estado   : ${ESTADO_LABEL[r.turno_estado] || r.turno_estado}\n`;
    if (r.descripcion)         txt += `      Problema : ${r.descripcion}\n`;
    if (r.diag_notas)          txt += `      Diagnóst.: ${r.diag_notas}\n`;
    if (r.descripcion_trabajo) txt += `      Trabajo  : ${r.descripcion_trabajo}\n`;
    if (r.materiales)          txt += `      Materiales: ${r.materiales}\n`;
    if (r.precio_total)        txt += `      Precio   : $${Number(r.precio_total).toLocaleString('es-AR')} (mano de obra)\n`;
    if (r.rep_estado)          txt += `      Reparac. : ${ESTADO_LABEL[r.rep_estado] || r.rep_estado}\n`;
    if (r.rep_notas)           txt += `      Notas    : ${r.rep_notas}\n`;
    txt += `\n`;
  });

  txt += `${sepThin}\n\n`;
  if (totalGastado > 0) {
    txt += `  Total invertido (mano de obra): $${totalGastado.toLocaleString('es-AR')}\n\n`;
  }
  txt += `  Taller Schuster — Servicio de motos\n`;
  txt += `  Tel: ${MECANICO_TEL}\n`;

  const nombreArchivo = `${marca}-${rows[0].patente}-historial.txt`.replace(/\s+/g,'-').toLowerCase();
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivo}"`);
  res.send(txt);
});

// ─── HISTORIAL ────────────────────────────────────────────────────────────────
app.get('/api/admin/historial/:patente', (req, res) => {
  const db = getDb();
  const patente = req.params.patente.toUpperCase().replace(/[\s\-]/g,'');

  const turnos = db.prepare(`
    SELECT t.*,
      d.estado as diag_estado, d.notas as diag_notas,
      r.estado as rep_estado, r.notas as rep_notas,
      p.descripcion_trabajo, p.precio_total, p.materiales
    FROM turnos t
    LEFT JOIN diagnosticos d ON d.turno_id=t.id
    LEFT JOIN presupuestos p ON p.diagnostico_id=d.id
    LEFT JOIN reparaciones r ON r.presupuesto_id=p.id
    WHERE UPPER(REPLACE(REPLACE(t.patente,' ',''),'-','')) = ?
    ORDER BY t.fecha DESC, t.hora_inicio DESC
  `).all(patente);

  if (turnos.length === 0) return res.status(404).json({ error: 'No se encontró historial para esa patente' });

  const info = {
    nombre: turnos[0].nombre,
    telefono: turnos[0].telefono,
    marca_moto: turnos[0].marca_moto,
    modelo_moto: turnos[0].modelo_moto,
    patente: turnos[0].patente
  };
  res.json({ info, historial: turnos });
});

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
app.get('/api/admin/dashboard', (req, res) => {
  const db = getDb();
  const hoy = new Date().toISOString().split('T')[0];

  const turnos_hoy         = db.prepare(`SELECT * FROM turnos WHERE fecha=? AND estado NOT IN ('cancelado','no_presentado') ORDER BY hora_inicio`).all(hoy);
  const services_activos   = db.prepare(`SELECT * FROM turnos WHERE estado='confirmado' AND fecha>=? ORDER BY fecha,hora_inicio`).all(hoy);
  const reparaciones_activas = db.prepare(`
    SELECT r.*,t.nombre,t.marca_moto,t.modelo_moto,t.patente,p.descripcion_trabajo
    FROM reparaciones r JOIN presupuestos p ON r.presupuesto_id=p.id
    JOIN diagnosticos d ON p.diagnostico_id=d.id JOIN turnos t ON d.turno_id=t.id
    WHERE r.estado IN ('aprobado','en_reparacion')
  `).all();
  const diags_activos = db.prepare(`
    SELECT t.* FROM turnos t JOIN diagnosticos d ON d.turno_id=t.id
    WHERE t.estado='confirmado' AND t.fecha>=? AND d.estado IN ('pendiente','en_revision','presupuesto_generado')
  `).all(hoy);

  const ocupados  = services_activos.length + diags_activos.length + reparaciones_activas.length;
  const diag_pend = db.prepare(`SELECT COUNT(*) as c FROM diagnosticos WHERE estado IN ('pendiente','en_revision')`).get();
  const pres_pend = db.prepare(`SELECT COUNT(*) as c FROM presupuestos WHERE estado='pendiente'`).get();
  const no_pres   = db.prepare(`SELECT COUNT(*) as c FROM turnos WHERE estado='confirmado' AND fecha<?`).get(hoy);

  res.json({
    turnos_hoy, reparaciones_activas, services_activos,
    capacidad_taller: { usada: Math.min(ocupados, 3), total: 3 },
    diagnosticos_pendientes: diag_pend.c,
    presupuestos_esperando: pres_pend.c,
    turnos_no_presentados: no_pres.c,
  });
});

// ─── PRECIOS SERVICE ──────────────────────────────────────────────────────────
app.get('/api/precios-service', (req, res) => {
  res.json(getDb().prepare('SELECT * FROM precios_service ORDER BY cilindrada, mantenimiento').all());
});

app.get('/api/precios-service/:cilindrada', (req, res) => {
  const rows = getDb().prepare('SELECT * FROM precios_service WHERE cilindrada=? ORDER BY id').all(req.params.cilindrada);
  if (!rows.length) return res.status(404).json({ error: 'Cilindrada no encontrada' });
  res.json(rows);
});

app.patch('/api/admin/precios-service/:cilindrada/:mantenimiento', (req, res) => {
  const { precio, nombre_cilindrada, nombre_mantenimiento, detalles } = req.body;
  if (precio !== undefined && (isNaN(precio) || precio < 0)) return res.status(400).json({ error: 'Precio inválido' });
  const db = getDb();
  const { cilindrada, mantenimiento } = req.params;
  if (precio !== undefined)             db.prepare(`UPDATE precios_service SET precio=?, updated_at=datetime('now') WHERE cilindrada=? AND mantenimiento=?`).run(parseFloat(precio), cilindrada, mantenimiento);
  if (nombre_cilindrada !== undefined)  db.prepare(`UPDATE precios_service SET nombre_cilindrada=?, updated_at=datetime('now') WHERE cilindrada=? AND mantenimiento=?`).run(nombre_cilindrada, cilindrada, mantenimiento);
  if (nombre_mantenimiento !== undefined) db.prepare(`UPDATE precios_service SET nombre_mantenimiento=?, updated_at=datetime('now') WHERE cilindrada=? AND mantenimiento=?`).run(nombre_mantenimiento, cilindrada, mantenimiento);
  if (detalles !== undefined)           db.prepare(`UPDATE precios_service SET detalles=?, updated_at=datetime('now') WHERE cilindrada=? AND mantenimiento=?`).run(detalles, cilindrada, mantenimiento);
  res.json({ ok: true });
});

// ─── UTILIDADES ───────────────────────────────────────────────────────────────
function generarBloques() {
  const b = [];
  for (let h = 8; h < 12; h++) b.push(`${String(h).padStart(2,'0')}:00`);
  for (let h = 15; h < 20; h++) b.push(`${String(h).padStart(2,'0')}:00`);
  return b;
}
function esDentroDeHorario(hora, dur) {
  const h = parseInt(hora.split(':')[0]);
  const fin = h + dur;
  return (h >= 8 && fin <= 12) || (h >= 15 && fin <= 20);
}

// ─── BACKUP AUTOMÁTICO ────────────────────────────────────────────────────────
function hacerBackup() {
  try {
    const dbPath = path.join(__dirname, 'taller.db');
    if (!fs.existsSync(dbPath)) return;
    const backupDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);
    const fecha = new Date().toISOString().split('T')[0];
    const dest  = path.join(backupDir, `taller-backup-${fecha}.db`);
    fs.copyFileSync(dbPath, dest);
    console.log(`✅ [BACKUP] ${dest}`);
    const archivos = fs.readdirSync(backupDir).filter(f => f.startsWith('taller-backup-')).sort();
    if (archivos.length > 7) archivos.slice(0, archivos.length - 7).forEach(f => fs.unlinkSync(path.join(backupDir, f)));
  } catch(e) { console.error('❌ [BACKUP]', e.message); }
}

// ─── CRON ─────────────────────────────────────────────────────────────────────
cron.schedule('0 23 * * *', hacerBackup);

cron.schedule('0 8 * * *', () => {
  try {
    const db = getDb();
    const hoy = new Date().toISOString().split('T')[0];
    const r = db.prepare(`UPDATE turnos SET estado='no_presentado' WHERE estado='confirmado' AND fecha<?`).run(hoy);
    if (r.changes > 0) console.log(`⚠️ [CRON] ${r.changes} turno(s) marcados como no_presentado`);

    const manana = new Date(); manana.setDate(manana.getDate() + 1);
    const fechaManana = manana.toISOString().split('T')[0];
    const turnos = db.prepare(`SELECT * FROM turnos WHERE fecha=? AND estado IN ('pendiente','confirmado')`).all(fechaManana);
    if (turnos.length > 0) {
      console.log(`📅 [RECORDATORIO] ${turnos.length} turno(s) mañana ${fechaManana}:`);
      turnos.forEach(t => {
        const msg = `📅 *Recordatorio Taller Schuster*\n\nHola ${t.nombre}, mañana es tu turno.\n\n🕐 ${t.hora_inicio} hs\n🏍️ ${t.marca_moto} ${t.modelo_moto}\n\n¡Te esperamos!`;
        console.log(`  ${t.hora_inicio} | ${t.nombre} | ${waLink(t.telefono, msg)}`);
      });
    }
  } catch(e) { console.error('❌ [CRON]', e.message); }
});

setInterval(() => {
  try { persistDb(); console.log(`💾 [AUTO-SAVE] ${new Date().toLocaleTimeString('es-AR')}`); }
  catch(e) { console.error('❌ [AUTO-SAVE]', e.message); }
}, 5 * 60 * 1000);

// ─── INICIO ───────────────────────────────────────────────────────────────────
initDb().then(() => {
  hacerBackup();
  app.listen(PORT, () => console.log(`✅ Servidor corriendo en http://localhost:${PORT}`));
}).catch(e => { console.error('❌ Error iniciando:', e); process.exit(1); });
