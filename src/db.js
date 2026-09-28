const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const config = require('./config');

let db;

function open() {
  if (!fs.existsSync(config.DATA_DIR)) fs.mkdirSync(config.DATA_DIR, { recursive: true });
  db = new Database(path.join(config.DATA_DIR, 'frims.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function createSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sections (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL UNIQUE,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE,
      email         TEXT NOT NULL UNIQUE,
      full_name     TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL CHECK (role IN ('field_ranger','section_ranger','ecologist','admin')),
      section_id    INTEGER REFERENCES sections(id),
      status        TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Invited','Inactive')),
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS incidents (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      reference     TEXT NOT NULL UNIQUE,
      client_id     TEXT,
      type          TEXT NOT NULL,
      severity      TEXT NOT NULL CHECK (severity IN ('Low','Medium','High')),
      status        TEXT NOT NULL CHECK (status IN ('Open','Escalated','Resolved')),
      notes         TEXT,
      latitude      REAL NOT NULL,
      longitude     REAL NOT NULL,
      reported_by   INTEGER NOT NULL REFERENCES users(id),
      section_id    INTEGER REFERENCES sections(id),
      photo_path    TEXT,
      ai_suggestion TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_incidents_section  ON incidents(section_id);
    CREATE INDEX IF NOT EXISTS idx_incidents_reporter ON incidents(reported_by);
    CREATE INDEX IF NOT EXISTS idx_incidents_status   ON incidents(status);
    CREATE INDEX IF NOT EXISTS idx_incidents_severity ON incidents(severity);
    CREATE INDEX IF NOT EXISTS idx_incidents_created  ON incidents(created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_incidents_client
      ON incidents(reported_by, client_id) WHERE client_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS alerts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
      message     TEXT NOT NULL,
      severity    TEXT NOT NULL,
      is_read     INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_incident ON alerts(incident_id);

    CREATE TABLE IF NOT EXISTS audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_name TEXT NOT NULL,
      entity_id   INTEGER,
      action      TEXT NOT NULL,
      user_id     INTEGER REFERENCES users(id),
      old_value   TEXT,
      new_value   TEXT,
      timestamp   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_name, entity_id);
  `);
}

// UTC timestamp in SQLite's own format ("YYYY-MM-DD HH:MM:SS")
function daysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString().replace('T', ' ').slice(0, 19);
}

function seed() {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return;

  db.transaction(() => {
    const insertSection = db.prepare('INSERT INTO sections (name, description) VALUES (?, ?)');
    const sections = {};
    ['Kruger South', 'Kruger North', 'Kruger Central', 'Addo Elephant'].forEach((name) => {
      sections[name] = insertSection.run(name, name + ' ranger section').lastInsertRowid;
    });

    const insertUser = db.prepare(`
      INSERT INTO users (username, email, full_name, password_hash, role, section_id, status)
      VALUES (@username, @email, @full_name, @password_hash, @role, @section_id, 'Active')
    `);

    const KS = sections['Kruger South'], KN = sections['Kruger North'];
    const users = [
      { username:'admin',      full_name:'System Administrator', role:'admin',          section_id:null, password:'Admin@123'  },
      { username:'s.mahlangu', full_name:'Sipho Mahlangu',       role:'section_ranger', section_id:KS,   password:'Ranger@123' },
      { username:'t.nkosi',    full_name:'Thabo Nkosi',          role:'field_ranger',   section_id:KS,   password:'Ranger@123' },
      { username:'m.dlamini',  full_name:'Musa Dlamini',         role:'field_ranger',   section_id:KS,   password:'Ranger@123' },
      { username:'k.vanwyk',   full_name:'Kobus van Wyk',        role:'field_ranger',   section_id:KS,   password:'Ranger@123' },
      { username:'n.zulu',     full_name:'Nomvula Zulu',         role:'field_ranger',   section_id:KS,   password:'Ranger@123' },
      { username:'ecologist',  full_name:'Dr Lerato Mokoena',    role:'ecologist',      section_id:null, password:'Eco@123'    },
      { username:'j.botha',    full_name:'Johan Botha',          role:'section_ranger', section_id:KN,   password:'Ranger@123' },
      { username:'p.molefe',   full_name:'Palesa Molefe',        role:'field_ranger',   section_id:KN,   password:'Ranger@123' },
    ];

    const ids = {};
    users.forEach((u) => {
      ids[u.username] = insertUser.run({
        username: u.username, email: u.username + '@sanparks.org', full_name: u.full_name,
        password_hash: bcrypt.hashSync(u.password, 10), role: u.role, section_id: u.section_id,
      }).lastInsertRowid;
    });

    const insertIncident = db.prepare(`
      INSERT INTO incidents (reference,type,severity,status,notes,latitude,longitude,reported_by,section_id,ai_suggestion,created_at,updated_at)
      VALUES (@reference,@type,@severity,@status,@notes,@latitude,@longitude,@reported_by,@section_id,@severity,@created_at,@created_at)
    `);
    const insertAlert = db.prepare(`INSERT INTO alerts (incident_id, message, severity, is_read, created_at) VALUES (?, ?, 'High', ?, ?)`);
    const insertAudit = db.prepare(`INSERT INTO audit_log (entity_name, entity_id, action, user_id, timestamp) VALUES ('incident', ?, 'created', ?, ?)`);

    [
      { reference:'INC-0412', type:'Snare found',       severity:'High',   status:'Open',      notes:'Fresh wire snare near waterhole, signs of recent activity.', latitude:-25.1023, longitude:31.5182, by:'t.nkosi',   sec:KS, created_at:daysAgo(0.5) },
      { reference:'INC-0408', type:'Poaching activity', severity:'High',   status:'Escalated', notes:'Tracks of two people and a vehicle near dry riverbed.',      latitude:-23.4520, longitude:31.3810, by:'p.molefe',  sec:KN, created_at:daysAgo(1.5) },
      { reference:'INC-0405', type:'Fence breach',      severity:'Medium', status:'Escalated', notes:'Cut fence with fresh vehicle tracks nearby.',                latitude:-25.0981, longitude:31.5240, by:'m.dlamini', sec:KS, created_at:daysAgo(1)   },
      { reference:'INC-0401', type:'Carcass found',     severity:'Medium', status:'Open',      notes:'Buffalo carcass, cause of death unclear.',                   latitude:-23.5210, longitude:31.4200, by:'p.molefe',  sec:KN, created_at:daysAgo(3)   },
      { reference:'INC-0398', type:'Wildlife sighting', severity:'Low',    status:'Resolved',  notes:'Herd of 12 elephants near Sabie river.',                     latitude:-25.1102, longitude:31.5090, by:'t.nkosi',   sec:KS, created_at:daysAgo(2)   },
      { reference:'INC-0391', type:'Poaching activity', severity:'High',   status:'Resolved',  notes:'Two individuals in camouflage moving north near boundary.',  latitude:-25.1620, longitude:31.4710, by:'k.vanwyk',  sec:KS, created_at:daysAgo(4)   },
      { reference:'INC-0380', type:'Snare found',       severity:'Medium', status:'Resolved',  notes:'Wire snare, no recent activity apparent.',                   latitude:-25.2140, longitude:31.4510, by:'m.dlamini', sec:KS, created_at:daysAgo(6)   },
      { reference:'INC-0374', type:'Vehicle in restricted area', severity:'Low', status:'Resolved', notes:'Tourist vehicle strayed off permitted road.',          latitude:-25.1300, longitude:31.5600, by:'t.nkosi',   sec:KS, created_at:daysAgo(8)   },
    ].forEach((i) => {
      const id = insertIncident.run({
        reference: i.reference, type: i.type, severity: i.severity, status: i.status, notes: i.notes,
        latitude: i.latitude, longitude: i.longitude, reported_by: ids[i.by], section_id: i.sec,
        created_at: i.created_at,
      }).lastInsertRowid;
      insertAudit.run(id, ids[i.by], i.created_at);
      if (i.severity === 'High') {
        insertAlert.run(id, `High-severity incident logged: ${i.type} (${i.reference})`, i.status === 'Resolved' ? 1 : 0, i.created_at);
      }
    });
  })();

  console.log('FRIMS database seeded (9 users, 8 incidents).');
}

function initDb() {
  open();
  createSchema();
  seed();
  return db;
}

function getDb() {
  if (!db) throw new Error('Database not initialised');
  return db;
}

function closeDb() {
  if (db) { db.close(); db = null; }
}

module.exports = { initDb, getDb, closeDb, daysAgo };
