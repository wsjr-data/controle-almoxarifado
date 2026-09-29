const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'almoxarifado.db');

class DatabaseWrapper {
  constructor() {
    this.db = null;
    this.ready = this.init();
  }

  async init() {
    const SQL = await initSqlJs();
    if (fs.existsSync(dbPath)) {
      const filebuffer = fs.readFileSync(dbPath);
      this.db = new SQL.Database(filebuffer);
    } else {
      this.db = new SQL.Database();
      this.save();
    }

    // Criar Tabelas com os novos campos de cautela detalhada
    this.db.run(`
      CREATE TABLE IF NOT EXISTS funcionarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT NOT NULL,
        setor TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS materiais (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        codigo_ref TEXT UNIQUE NOT NULL,
        nome TEXT NOT NULL,
        categoria TEXT NOT NULL,
        status TEXT DEFAULT 'DISPONIVEL'
      );
      CREATE TABLE IF NOT EXISTS movimentacoes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        material_id INTEGER NOT NULL,
        funcionario_id INTEGER NOT NULL,
        acessorios TEXT,
        destino TEXT,
        data_retirada DATETIME DEFAULT CURRENT_TIMESTAMP,
        data_devolucao DATETIME,
        observacao TEXT,
        condicao_devolucao TEXT
      );
    `);
    this.save();
  }

  save() {
    if (!this.db) return;
    const data = this.db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
  }

  get(sql, params = [], callback) {
    this.ready.then(() => {
      try {
        const stmt = this.db.prepare(sql);
        stmt.bind(params);
        if (stmt.step()) {
          const row = stmt.getAsObject();
          stmt.free();
          callback(null, row);
        } else {
          stmt.free();
          callback(null, null);
        }
      } catch (err) {
        callback(err);
      }
    });
  }

  all(sql, params = [], callback) {
    this.ready.then(() => {
      try {
        const stmt = this.db.prepare(sql);
        stmt.bind(params);
        const rows = [];
        while (stmt.step()) {
          rows.push(stmt.getAsObject());
        }
        stmt.free();
        callback(null, rows);
      } catch (err) {
        callback(err);
      }
    });
  }

  run(sql, params = [], callback) {
    this.ready.then(() => {
      try {
        this.db.run(sql, params);
        this.save();
        if (callback) callback(null);
      } catch (err) {
        if (callback) callback(err);
      }
    });
  }
}

module.exports = new DatabaseWrapper();