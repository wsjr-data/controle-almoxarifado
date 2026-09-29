const express = require('express');
const cors = require('cors');
const db = require('./database');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ==========================================
// ROTAS DE CONSULTA E CAUTELA
// ==========================================

// Pesquisar materiais por Código ou Nome
app.get('/api/materiais/busca/pesquisa', (req, res) => {
  const termo = req.query.q || '';
  if (!termo.trim()) return res.json([]);

  const query = `
    SELECT m.*, f.nome as usuario_atual, mov.data_retirada, mov.acessorios, mov.destino
    FROM materiais m
    LEFT JOIN movimentacoes mov ON m.id = mov.material_id AND mov.data_devolucao IS NULL
    LEFT JOIN funcionarios f ON mov.funcionario_id = f.id
    WHERE m.codigo_ref LIKE ? OR m.nome LIKE ?
    LIMIT 10
  `;
  const param = `%${termo.trim()}%`;
  
  db.all(query, [param, param], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Buscar status de um material específico pelo código ou ID
app.get('/api/materiais/:codigo', (req, res) => {
  const { codigo } = req.params;
  const query = `
    SELECT m.*, f.nome as usuario_atual, mov.data_retirada, mov.acessorios, mov.destino, mov.observacao
    FROM materiais m
    LEFT JOIN movimentacoes mov ON m.id = mov.material_id AND mov.data_devolucao IS NULL
    LEFT JOIN funcionarios f ON mov.funcionario_id = f.id
    WHERE m.codigo_ref = ? OR m.id = ?
  `;
  db.get(query, [codigo, codigo], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ message: 'Material não encontrado.' });
    res.json(row);
  });
});

// Empréstimo (Retirada)
app.post('/api/cautela/retirar', (req, res) => {
  const { codigo_ref, funcionario_id, acessorios, destino, observacao, data_retirada } = req.body;

  if (!funcionario_id || !destino) {
    return res.status(400).json({ error: 'Informe o funcionário responsável e o local/obra de destino.' });
  }

  db.get('SELECT * FROM materiais WHERE codigo_ref = ?', [codigo_ref], (err, material) => {
    if (err || !material) return res.status(404).json({ error: 'Material não encontrado.' });
    if (material.status === 'EM_USO') return res.status(400).json({ error: 'Material já está emprestado!' });

    const dataFinal = data_retirada || new Date().toISOString();

    db.run(
      `INSERT INTO movimentacoes (material_id, funcionario_id, acessorios, destino, observacao, data_retirada) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [material.id, funcionario_id, acessorios || '', destino, observacao || '', dataFinal],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });

        db.run('UPDATE materiais SET status = "EM_USO" WHERE id = ?', [material.id], () => {
          res.json({ message: 'Retirada registrada com sucesso!' });
        });
      }
    );
  });
});

// Devolução
app.post('/api/cautela/devolver', (req, res) => {
  const { codigo_ref, condicao_devolucao } = req.body;

  db.get('SELECT * FROM materiais WHERE codigo_ref = ?', [codigo_ref], (err, material) => {
    if (err || !material) return res.status(404).json({ error: 'Material não encontrado.' });
    if (material.status === 'DISPONIVEL') return res.status(400).json({ error: 'Material já consta como disponível.' });

    const queryMov = `
      UPDATE movimentacoes 
      SET data_devolucao = CURRENT_TIMESTAMP, condicao_devolucao = ?
      WHERE material_id = ? AND data_devolucao IS NULL
    `;

    db.run(queryMov, [condicao_devolucao || 'Devolvido em ordem', material.id], function (err) {
      if (err) return res.status(500).json({ error: err.message });

      db.run('UPDATE materiais SET status = "DISPONIVEL" WHERE id = ?', [material.id], () => {
        res.json({ message: 'Devolução registrada e horário arquivado com sucesso!' });
      });
    });
  });
});

// ==========================================
// ROTAS DE HISTÓRICO E RELATÓRIOS
// ==========================================

// Obter todo o histórico de cautelas (Ativas e Devolvidas)
app.get('/api/historico', (req, res) => {
  const query = `
    SELECT 
      mov.id,
      m.nome as material_nome,
      m.codigo_ref,
      m.categoria,
      f.nome as funcionario_nome,
      f.setor as funcionario_setor,
      mov.acessorios,
      mov.destino,
      mov.data_retirada,
      mov.data_devolucao,
      mov.observacao,
      mov.condicao_devolucao
    FROM movimentacoes mov
    JOIN materiais m ON mov.material_id = m.id
    JOIN funcionarios f ON mov.funcionario_id = f.id
    ORDER BY mov.id DESC
  `;
  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// ==========================================
// ROTAS DE GESTÃO E CADASTROS
// ==========================================

app.get('/api/funcionarios', (req, res) => {
  db.all('SELECT * FROM funcionarios ORDER BY nome ASC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/funcionarios', (req, res) => {
  const { nome, setor } = req.body;
  if (!nome || !setor) {
    return res.status(400).json({ error: 'Preencha o nome e o setor do funcionário.' });
  }

  db.run(
    'INSERT INTO funcionarios (nome, setor) VALUES (?, ?)',
    [nome.trim(), setor.trim()],
    function (err) {
      if (err) return res.status(500).json({ error: 'Erro ao cadastrar funcionário.' });
      res.json({ message: 'Funcionário cadastrado com sucesso!' });
    }
  );
});

app.get('/api/materiais', (req, res) => {
  db.all('SELECT * FROM materiais ORDER BY nome ASC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/materiais', (req, res) => {
  const { codigo_ref, nome, categoria } = req.body;
  if (!codigo_ref || !nome || !categoria) {
    return res.status(400).json({ error: 'Preencha todos os campos do material.' });
  }

  db.run(
    'INSERT INTO materiais (codigo_ref, nome, categoria) VALUES (?, ?, ?)',
    [codigo_ref.trim().toUpperCase(), nome.trim(), categoria.trim()],
    function (err) {
      if (err) return res.status(400).json({ error: 'Código de etiqueta já existente.' });
      res.json({ message: 'Material cadastrado com sucesso!' });
    }
  );
});

// Dados de teste iniciais
app.get('/api/seed', (req, res) => {
  db.run(`INSERT OR IGNORE INTO funcionarios (id, nome, setor) VALUES 
    (1, 'Carlos Silva', 'Marcenaria'),
    (2, 'Ana Souza', 'Montagem')`);

  db.run(`INSERT OR IGNORE INTO materiais (id, codigo_ref, nome, categoria) VALUES 
    (1, 'FUR-001', 'Furadeira DeWalt 20V', 'Ferramentas Elétricas'),
    (2, 'SER-002', 'Serra Tico-Tico Bosch', 'Ferramentas Elétricas')`, () => {
      res.json({ message: 'Dados de teste criados com sucesso!' });
  });
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
}); 