// server.js - Servidor principal del Taller Schuster
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { getDb, initDb } = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;

// Número del mecánico para notificaciones
const MECANICO_TEL = '3735582128';

// ─── HELPERS WHATSAPP ──────────────────────────────────────────────────────────
// Genera un link wa.me con mensaje pre-armado (el frontend lo abre)
function waLink(telefono, mensaje) {
  const tel = telefono.replace(/\D/g, '');
  const num = tel.startsWith('54') ? tel : `54${tel}`;
  return `https://wa.me/${num}?text=${encodeURIComponent(mensaje)}`;
}

function waMecanico(mensaje) {
  return waLink(MECANICO_TEL, mensaje);
}

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json());

// ─── DISPONIBILIDAD ───────────────────────────────────────────────────────────

app.get('/api/disponibilidad', (req, res) => {
  const { fecha, tipo } = req.query;
  if (!fecha || !tipo) return res.status(400).json({ error: 'Falta fecha o tipo' });

  // Bloquear fechas con menos de 1 día de anticipación
  const hoy = new Date();
  hoy.setHours(0,0,0,0);
  const fechaSel = new Date(fecha + 'T00:00:00');
  const diffDias = (fechaSel - hoy) / (1000 * 60 * 60 * 24);
  if (diffDias < 1) {
    return res.json({ disponibles: [], mensaje: 'Reservas con al menos 1 día de anticipación' });
  }

  const db = getDb();
  const bloques = generarBloques();
  const turnos = db.prepare(`
    SELECT hora_inicio, hora_fin FROM turnos
    WHERE fecha = ? AND estado != 'cancelado'
  `).all(fecha);

  const horasOcupadas = new Set();
  turnos.forEach(t => {
    for (let h = parseInt(t.hora_inicio.split(':')[0]); h < parseInt(t.hora_fin.split(':')[0]); h++) {
      horasOcupadas.add(`${String(h).padStart(2, '0')}:00`);
    }
  });

  const duracion = tipo === 'service' ? 2 : 1;
  const disponibles = bloques.filter(bloque => {
    const hora = parseInt(bloque.split(':')[0]);
    for (let d = 0; d < duracion; d++) {
      const checkHora = hora + d;
      const checkBloque = `${String(checkHora).padStart(2, '0')}:00`;
      if (horasOcupadas.has(checkBloque)) return false;
      if (!esDentroDeHorario(bloque, duracion)) return false;
    }
    return true;
  });

  res.json({ disponibles });
});

// ─── CREAR TURNO ──────────────────────────────────────────────────────────────

app.post('/api/turnos', (req, res) => {
  const { nombre, telefono, marca_moto, modelo_moto, patente, tipo_servicio, tipo_service, descripcion, fecha, hora_inicio } = req.body;

  if (!nombre || !telefono || !marca_moto || !modelo_moto || !patente || !tipo_servicio || !fecha || !hora_inicio) {
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  }
  if (tipo_servicio === 'diagnostico' && !descripcion) {
    return res.status(400).json({ error: 'La descripción es obligatoria para diagnóstico' });
  }

  const db = getDb();
  const duracion = tipo_servicio === 'service' ? 2 : 1;
  const [h, m] = hora_inicio.split(':').map(Number);
  const hora_fin = `${String(h + duracion).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

  const conflicto = db.prepare(`
    SELECT id FROM turnos
    WHERE fecha = ? AND estado != 'cancelado'
    AND NOT (hora_fin <= ? OR hora_inicio >= ?)
  `).get(fecha, hora_inicio, hora_fin);
  if (conflicto) return res.status(409).json({ error: 'El horario ya está ocupado' });

  const { v4: uuidv4 } = require('uuid');
  const id = uuidv4();

  db.prepare(`
    INSERT INTO turnos (id, nombre, telefono, marca_moto, modelo_moto, patente, tipo_servicio, descripcion, fecha, hora_inicio, hora_fin, estado)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente')
  `).run(id, nombre, telefono, marca_moto, modelo_moto, patente, tipo_servicio, descripcion || null, fecha, hora_inicio, hora_fin);

  if (tipo_service) {
    db.prepare('UPDATE turnos SET descripcion = ? WHERE id = ?').run(`[${tipo_service}] ${descripcion || ''}`.trim(), id);
  }

  if (tipo_servicio === 'diagnostico') {
    db.prepare(`INSERT INTO diagnosticos (id, turno_id) VALUES (?, ?)`).run(uuidv4(), id);
  }

  const turno = db.prepare('SELECT * FROM turnos WHERE id = ?').get(id);

  // Link WhatsApp para notificar al mecánico de nuevo turno
  const tipoLabel = tipo_servicio === 'service' ? 'Service' : 'Diagnóstico';
  const msgMecanico = `🔧 *Nuevo turno recibido*\n\n👤 ${nombre}\n📱 ${telefono}\n🏍️ ${marca_moto} ${modelo_moto} · ${patente}\n📋 ${tipoLabel}\n📅 ${fecha} a las ${hora_inicio} hs${descripcion ? '\n💬 ' + descripcion : ''}\n\n_Revisá el panel admin para confirmar._`;

  res.status(201).json({
    turno,
    mensaje: 'Turno creado exitosamente',
    wa_mecanico: waMecanico(msgMecanico)
  });
});

// ─── ADMIN - TURNOS ───────────────────────────────────────────────────────────

app.get('/api/admin/turnos', (req, res) => {
  const db = getDb();
  const { fecha } = req.query;
  let query = 'SELECT * FROM turnos';
  const params = [];
  if (fecha) { query += ' WHERE fecha = ?'; params.push(fecha); }
  query += ' ORDER BY fecha ASC, hora_inicio ASC';
  res.json(db.prepare(query).all(...params));
});

app.patch('/api/admin/turnos/:id', (req, res) => {
  const db = getDb();
  const { estado } = req.body;
  const validos = ['pendiente', 'confirmado', 'cancelado', 'completado'];
  if (!validos.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });

  const turno = db.prepare('SELECT * FROM turnos WHERE id = ?').get(req.params.id);
  let wa_cliente = turno.wa_cliente || null;

  if (estado === 'confirmado') {
    const tipoLabel = turno.tipo_servicio === 'service' ? 'Service' : 'Diagnóstico';
    const msg = `✅ *Turno confirmado - Taller Schuster*\n\nHola ${turno.nombre}, tu turno fue confirmado.\n\n📋 ${tipoLabel}\n📅 ${turno.fecha} a las ${turno.hora_inicio} hs\n🏍️ ${turno.marca_moto} ${turno.modelo_moto}\n\nPodés traer la moto. ¡Te esperamos!`;
    wa_cliente = waLink(turno.telefono, msg);
  }

  if (estado === 'completado') {
    const tipoLabel = turno.tipo_servicio === 'service' ? 'service' : 'diagnóstico';
    const msg = `✅ *Taller Schuster*\n\nHola ${turno.nombre}, el ${tipoLabel} de tu ${turno.marca_moto} ${turno.modelo_moto} fue completado. Podés pasar a retirar la moto cuando quieras. ¡Gracias!`;
    wa_cliente = waLink(turno.telefono, msg);
  }

  db.prepare('UPDATE turnos SET estado = ?, wa_cliente = ? WHERE id = ?').run(estado, wa_cliente, req.params.id);
  res.json({ ok: true, wa_cliente });
});

app.delete('/api/admin/turnos/:id', (req, res) => {
  const db = getDb();
  db.prepare("UPDATE turnos SET estado = 'cancelado' WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ─── ADMIN - CONTEO TURNOS TOTAL ─────────────────────────────────────────────
app.get('/api/admin/turnos-count', (req, res) => {
  const db = getDb();
  const result = db.prepare(`
    SELECT COUNT(*) as c FROM turnos 
    WHERE estado IN ('pendiente', 'confirmado')
  `).get();
  res.json({ count: result.c });
});

// ─── ADMIN - SERVICES ACTIVOS ─────────────────────────────────────────────────

app.get('/api/admin/services-activos', (req, res) => {
  const db = getDb();
  const activos = db.prepare(`
    SELECT * FROM turnos
    WHERE estado = 'confirmado'
    ORDER BY fecha ASC, hora_inicio ASC
  `).all();
  res.json(activos);
});

// ─── ADMIN - DIAGNÓSTICOS ─────────────────────────────────────────────────────

app.get('/api/admin/diagnosticos', (req, res) => {
  const db = getDb();
  const diagnosticos = db.prepare(`
    SELECT d.*, t.nombre, t.telefono, t.marca_moto, t.modelo_moto, t.patente,
           t.descripcion, t.fecha, t.hora_inicio
    FROM diagnosticos d
    JOIN turnos t ON d.turno_id = t.id
    WHERE d.estado NOT IN ('completado', 'sin_reparacion')
    ORDER BY t.fecha DESC
  `).all();
  res.json(diagnosticos);
});

app.patch('/api/admin/diagnosticos/:id', (req, res) => {
  const db = getDb();
  const { estado, notas } = req.body;
  const validos = ['pendiente', 'en_revision', 'presupuesto_generado', 'completado', 'sin_reparacion'];
  if (!validos.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });

  let wa_cliente = null;
  if (estado === 'sin_reparacion') {
    const diag = db.prepare(`
      SELECT d.*, t.nombre, t.telefono, t.marca_moto, t.modelo_moto
      FROM diagnosticos d JOIN turnos t ON d.turno_id = t.id WHERE d.id = ?
    `).get(req.params.id);
    if (diag) {
      const msg = `🔍 *Taller Schuster - Diagnóstico completado*\n\nHola ${diag.nombre}, el diagnóstico de tu ${diag.marca_moto} ${diag.modelo_moto} fue completado.\n\n_No se requiere reparación por el momento._\n\nPasá por el taller cuando quieras para que te demos más detalles y retirar la moto. ¡Gracias!`;
      wa_cliente = waLink(diag.telefono, msg);
    }
  }

  if (estado === 'completado') {
    const diag = db.prepare(`
      SELECT d.*, t.nombre, t.telefono, t.marca_moto, t.modelo_moto
      FROM diagnosticos d JOIN turnos t ON d.turno_id = t.id WHERE d.id = ?
    `).get(req.params.id);
    if (diag) {
      const msg = `✅ *Taller Schuster*\n\nHola ${diag.nombre}, el diagnóstico de tu ${diag.marca_moto} ${diag.modelo_moto} fue completado. Podés pasar a retirar la moto. ¡Gracias!`;
      wa_cliente = waLink(diag.telefono, msg);
    }
  }

  // Get existing wa if no new one generated
  if (!wa_cliente) {
    const existing = db.prepare('SELECT wa_cliente FROM diagnosticos WHERE id = ?').get(req.params.id);
    wa_cliente = existing?.wa_cliente || null;
  }

  db.prepare(`UPDATE diagnosticos SET estado = ?, notas = ?, wa_cliente = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(estado, notas || null, wa_cliente, req.params.id);
  res.json({ ok: true, wa_cliente });
});

// ─── ADMIN - PRESUPUESTOS ─────────────────────────────────────────────────────

app.post('/api/admin/presupuestos', (req, res) => {
  const { diagnostico_id, descripcion_trabajo, materiales, precio_total, tiempo_estimado_dias } = req.body;
  if (!diagnostico_id || !descripcion_trabajo || !precio_total) {
    return res.status(400).json({ error: 'Faltan campos' });
  }

  const db = getDb();
  const { v4: uuidv4 } = require('uuid');
  const id = uuidv4();
  const token = uuidv4().replace(/-/g, '').substring(0, 16);

  db.prepare(`
    INSERT INTO presupuestos (id, diagnostico_id, descripcion_trabajo, materiales, precio_total, tiempo_estimado_dias, link_token)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, diagnostico_id, descripcion_trabajo, materiales || null, precio_total, tiempo_estimado_dias || 1, token);

  db.prepare("UPDATE diagnosticos SET estado = 'presupuesto_generado', updated_at = datetime('now') WHERE id = ?")
    .run(diagnostico_id);

  // Datos del cliente para armar el WhatsApp
  const info = db.prepare(`
    SELECT t.nombre, t.telefono, t.marca_moto, t.modelo_moto, t.patente
    FROM diagnosticos d JOIN turnos t ON d.turno_id = t.id WHERE d.id = ?
  `).get(diagnostico_id);

  const presupuesto = db.prepare('SELECT * FROM presupuestos WHERE id = ?').get(id);

  // Mensaje WhatsApp para el cliente con detalles del presupuesto
  let msgCliente = `🔧 *Presupuesto - Taller Schuster*\n\nHola ${info.nombre}, te enviamos el presupuesto para tu ${info.marca_moto} ${info.modelo_moto} (${info.patente}).\n\n📋 *Trabajo:* ${descripcion_trabajo}`;
  if (materiales) msgCliente += `\n🔩 *Materiales:* ${materiales}`;
  msgCliente += `\n💰 *Total: $${Number(precio_total).toLocaleString()}*`;
  msgCliente += `\n⏱️ *Tiempo estimado:* ${tiempo_estimado_dias} día${tiempo_estimado_dias > 1 ? 's' : ''}`;
  msgCliente += `\n\n¿Aprobás el presupuesto? Respondé *SI* para confirmar o *NO* para rechazar.\n\n_Taller Schuster_`;

  const wa_cliente = waLink(info.telefono, msgCliente);

  // Guardar el link en la DB para poder reenviarlo
  db.prepare('UPDATE presupuestos SET wa_cliente = ? WHERE id = ?').run(wa_cliente, id);

  res.status(201).json({ presupuesto, link_token: token, wa_cliente });
});

app.get('/api/admin/presupuestos', (req, res) => {
  const db = getDb();
  const presupuestos = db.prepare(`
    SELECT p.*, d.notas as diag_notas, t.nombre, t.telefono, t.marca_moto, t.modelo_moto, t.patente
    FROM presupuestos p
    JOIN diagnosticos d ON p.diagnostico_id = d.id
    JOIN turnos t ON d.turno_id = t.id
    ORDER BY p.created_at DESC
  `).all();
  res.json(presupuestos);
});

// Endpoint para que el admin marque manualmente si el cliente aceptó/rechazó por WhatsApp
app.patch('/api/admin/presupuestos/:id/responder', (req, res) => {
  const { decision } = req.body;
  if (!['aceptado', 'rechazado'].includes(decision)) return res.status(400).json({ error: 'Inválido' });

  const db = getDb();
  const pres = db.prepare('SELECT * FROM presupuestos WHERE id = ?').get(req.params.id);
  if (!pres) return res.status(404).json({ error: 'No encontrado' });

  db.prepare(`UPDATE presupuestos SET estado = ?, respondido_at = datetime('now') WHERE id = ?`)
    .run(decision, req.params.id);

  if (decision === 'aceptado') {
    const activas = db.prepare(`SELECT COUNT(*) as c FROM reparaciones WHERE estado IN ('aprobado', 'en_reparacion')`).get();
    if (activas.c >= 3) return res.status(409).json({ error: 'Taller lleno (3/3)' });

    const { v4: uuidv4 } = require('uuid');
    db.prepare(`INSERT INTO reparaciones (id, presupuesto_id, estado) VALUES (?, ?, 'aprobado')`).run(uuidv4(), pres.id);
  }

  res.json({ ok: true });
});

// ─── RUTA PÚBLICA PRESUPUESTO (mantener por compatibilidad) ──────────────────
app.get('/api/presupuesto/:token', (req, res) => {
  const db = getDb();
  const pres = db.prepare(`
    SELECT p.*, t.nombre, t.marca_moto, t.modelo_moto, t.patente
    FROM presupuestos p
    JOIN diagnosticos d ON p.diagnostico_id = d.id
    JOIN turnos t ON d.turno_id = t.id
    WHERE p.link_token = ?
  `).get(req.params.token);
  if (!pres) return res.status(404).json({ error: 'No encontrado' });
  res.json(pres);
});

// ─── ADMIN - REPARACIONES ─────────────────────────────────────────────────────

app.get('/api/admin/reparaciones', (req, res) => {
  const db = getDb();
  const reparaciones = db.prepare(`
    SELECT r.*, p.descripcion_trabajo, p.precio_total, p.tiempo_estimado_dias,
           t.nombre, t.telefono, t.marca_moto, t.modelo_moto, t.patente
    FROM reparaciones r
    JOIN presupuestos p ON r.presupuesto_id = p.id
    JOIN diagnosticos d ON p.diagnostico_id = d.id
    JOIN turnos t ON d.turno_id = t.id
    ORDER BY r.created_at DESC
  `).all();
  res.json(reparaciones);
});

app.patch('/api/admin/reparaciones/:id', (req, res) => {
  const db = getDb();
  const { estado, notas, fecha_estimada_fin } = req.body;
  const validos = ['aprobado', 'en_reparacion', 'finalizado', 'entregado'];
  if (!validos.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });

  const rep = db.prepare(`
    SELECT r.*, t.nombre, t.telefono, t.marca_moto, t.modelo_moto, p.precio_total
    FROM reparaciones r
    JOIN presupuestos p ON r.presupuesto_id = p.id
    JOIN diagnosticos d ON p.diagnostico_id = d.id
    JOIN turnos t ON d.turno_id = t.id
    WHERE r.id = ?
  `).get(req.params.id);

  let wa_cliente = rep.wa_cliente || null;
  if (estado === 'finalizado' || estado === 'entregado') {
    const msg = `✅ *Taller Schuster*\n\nHola ${rep.nombre}, la reparación de tu ${rep.marca_moto} ${rep.modelo_moto} está *finalizada*.\n\nPodés pasar a retirar la moto. ¡Gracias por confiar en nosotros!`;
    wa_cliente = waLink(rep.telefono, msg);
  }

  db.prepare(`UPDATE reparaciones SET estado = ?, notas = ?, fecha_estimada_fin = ?, wa_cliente = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(estado, notas || null, fecha_estimada_fin || null, wa_cliente, req.params.id);
  res.json({ ok: true, wa_cliente });
});

// ─── HISTORIAL POR PATENTE ────────────────────────────────────────────────────

app.get('/api/admin/historial/:patente', (req, res) => {
  const db = getDb();
  const patente = req.params.patente.toUpperCase();

  const turnos = db.prepare(`
    SELECT t.*,
      CASE WHEN d.id IS NOT NULL THEN 1 ELSE 0 END as tiene_diagnostico,
      d.estado as diag_estado, d.notas as diag_notas,
      r.estado as rep_estado, r.notas as rep_notas,
      p.descripcion_trabajo, p.precio_total, p.materiales
    FROM turnos t
    LEFT JOIN diagnosticos d ON d.turno_id = t.id
    LEFT JOIN presupuestos p ON p.diagnostico_id = d.id
    LEFT JOIN reparaciones r ON r.presupuesto_id = p.id
    WHERE UPPER(t.patente) = ?
    ORDER BY t.fecha DESC, t.hora_inicio DESC
  `).all(patente);

  if (turnos.length === 0) return res.status(404).json({ error: 'No se encontró historial para esa patente' });

  const info = { nombre: turnos[0].nombre, marca_moto: turnos[0].marca_moto, modelo_moto: turnos[0].modelo_moto, patente };
  res.json({ info, historial: turnos });
});

// ─── DASHBOARD ────────────────────────────────────────────────────────────────

app.get('/api/admin/dashboard', (req, res) => {
  const db = getDb();
  const hoy = new Date().toISOString().split('T')[0];

  const turnos_hoy = db.prepare(`
    SELECT * FROM turnos WHERE fecha = ? AND estado != 'cancelado' ORDER BY hora_inicio
  `).all(hoy);

  // Capacidad: turnos confirmados (service + diagnóstico) + reparaciones activas
  const services_activos = db.prepare(`
    SELECT * FROM turnos WHERE tipo_servicio = 'service' AND estado = 'confirmado'
  `).all();

  const diags_activos = db.prepare(`
    SELECT t.* FROM turnos t
    JOIN diagnosticos d ON d.turno_id = t.id
    WHERE t.estado = 'confirmado' AND d.estado IN ('pendiente','en_revision','presupuesto_generado')
  `).all();

  const reparaciones_activas = db.prepare(`
    SELECT r.*, t.nombre, t.marca_moto, t.modelo_moto, t.patente, p.descripcion_trabajo
    FROM reparaciones r
    JOIN presupuestos p ON r.presupuesto_id = p.id
    JOIN diagnosticos d ON p.diagnostico_id = d.id
    JOIN turnos t ON d.turno_id = t.id
    WHERE r.estado IN ('aprobado', 'en_reparacion')
  `).all();

  const ocupados = services_activos.length + diags_activos.length + reparaciones_activas.length;

  const diagnosticos_pendientes = db.prepare(`SELECT COUNT(*) as c FROM diagnosticos WHERE estado IN ('pendiente', 'en_revision')`).get();
  const presupuestos_esperando = db.prepare(`SELECT COUNT(*) as c FROM presupuestos WHERE estado = 'pendiente'`).get();

  res.json({
    turnos_hoy,
    reparaciones_activas,
    services_activos,
    capacidad_taller: { usada: Math.min(ocupados, 3), total: 3 },
    diagnosticos_pendientes: diagnosticos_pendientes.c,
    presupuestos_esperando: presupuestos_esperando.c
  });
});


// ─── PRECIOS SERVICE ──────────────────────────────────────────────────────────

app.get('/api/precios-service', (req, res) => {
  const db = getDb();
  res.json(db.prepare('SELECT * FROM precios_service ORDER BY id').all());
});

app.patch('/api/admin/precios-service/:tipo', (req, res) => {
  const { precio } = req.body;
  if (!precio || isNaN(precio)) return res.status(400).json({ error: 'Precio inválido' });
  const db = getDb();
  db.prepare("UPDATE precios_service SET precio = ?, updated_at = datetime('now') WHERE tipo = ?")
    .run(parseFloat(precio), req.params.tipo);
  res.json({ ok: true });
});

// ─── UTILIDADES ───────────────────────────────────────────────────────────────

function generarBloques() {
  const bloques = [];
  for (let h = 8; h < 12; h++) bloques.push(`${String(h).padStart(2, '0')}:00`);
  for (let h = 15; h < 20; h++) bloques.push(`${String(h).padStart(2, '0')}:00`);
  return bloques;
}

function esDentroDeHorario(hora_inicio, duracion) {
  const [h] = hora_inicio.split(':').map(Number);
  const fin = h + duracion;
  if (h >= 8 && h < 12) return fin <= 12;
  if (h >= 15 && h < 20) return fin <= 20;
  return false;
}

// ─── CRON - RECORDATORIO DIARIO ──────────────────────────────────────────────
cron.schedule('0 8 * * *', () => {
  const db = getDb();
  const manana = new Date();
  manana.setDate(manana.getDate() + 1);
  const fecha = manana.toISOString().split('T')[0];
  const turnos = db.prepare("SELECT * FROM turnos WHERE fecha = ? AND estado IN ('pendiente','confirmado')").all(fecha);
  if (turnos.length > 0) {
    console.log(`📅 [RECORDATORIO] ${turnos.length} turno(s) para mañana ${fecha}:`);
    turnos.forEach(t => console.log(`  - ${t.hora_inicio} | ${t.nombre} | ${t.marca_moto} ${t.modelo_moto} | ${t.telefono}`));
  }
});

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`✅ Servidor Taller Schuster corriendo en http://localhost:${PORT}`);
  });
});
